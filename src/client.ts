import { CookieJar } from "tough-cookie";
import type {
  Transport,
  Menu,
  MenuProduct,
  Product,
  StoreLocation,
  Store,
  Cart,
  PriceQuote,
  PickupEstimate,
  TransactionHistory,
  HistoryOptions,
  OrderRisk,
  OrderPickupTime,
  OrderStatus,
  SubmitOrderRequest,
  SubmittedOrder,
} from "./types.js";
import { toOrder } from "./cart.js";
import { allowedRequest, ORIGIN, SUBMIT_ORDER_PATH } from "./safety.js";
import {
  protectedRequestHeaders,
  validateRequestContext,
} from "./request-context.js";
import type { OrderRequestContext } from "./request-context.js";
import {
  validateSubmissionRequest,
  validateOrderReference,
} from "./order-validation.js";
export class StarbucksError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StarbucksError";
  }
}
export class OrderSubmissionDisabledError extends StarbucksError {
  constructor() {
    super(
      "Order submission is disabled in this transport. No order was placed.",
    );
    this.name = "OrderSubmissionDisabledError";
  }
}
export function parseResponse(status: number, body: string): unknown {
  if (status === 403) {
    let failure;
    try {
      failure = JSON.parse(body);
    } catch {
      /* Preserve ordinary HTTP errors for non-JSON responses. */
    }
    if (
      failure?.type === "authorize-operation" &&
      failure.roleProvided === "user:limited" &&
      failure.roleRequired === "user"
    )
      throw new StarbucksError(
        "Full sign-in required for checkout (current role: user:limited). Sign in again; profile access alone does not verify checkout access.",
        status,
        "REAUTHENTICATION_REQUIRED",
      );
  }
  if (status < 200 || status >= 300)
    throw new StarbucksError(
      `Starbucks returned HTTP ${status}${status === 429 ? "; stop and try again later" : ""}`,
      status,
    );
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new StarbucksError("Starbucks returned a non-JSON response", status);
  }
  if (
    data &&
    typeof data === "object" &&
    "errors" in data &&
    Array.isArray(data.errors) &&
    data.errors.length
  )
    throw new StarbucksError("Starbucks returned API errors", status);
  return data;
}
export interface HttpTransportOptions {
  cookieJar?: CookieJar;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Captured vendor proof, scoped to each protected operation. May expire server-side. */
  requestContext?: OrderRequestContext;
  /** Off by default. Only the exact member submit-order route is enabled. */
  allowOrderSubmission?: boolean;
}
/** All network I/O uses standard fetch; cookies follow RFC domain/path/expiry rules. */
export class HttpTransport implements Transport {
  readonly cookieJar: CookieJar;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly requestContext?: OrderRequestContext;
  constructor(private readonly options: HttpTransportOptions = {}) {
    if (options.requestContext) {
      validateRequestContext(options.requestContext);
      this.requestContext = structuredClone(options.requestContext);
    }
    this.cookieJar = options.cookieJar ?? new CookieJar();
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async request(path: string, body?: unknown): Promise<unknown> {
    const method = body === undefined ? "GET" : "POST";
    if (
      path === SUBMIT_ORDER_PATH &&
      this.options.allowOrderSubmission !== true
    )
      throw new OrderSubmissionDisabledError();
    if (
      !allowedRequest(path, method, this.options.allowOrderSubmission === true)
    )
      throw new Error(
        "Endpoint is not permitted; order submission is disabled",
      );
    const url = new URL(path, ORIGIN);
    const cookie = await this.cookieJar.getCookieString(url.href);
    const protection = protectedRequestHeaders(
      this.requestContext,
      url.pathname,
    );
    const headers = {
      ...protection,
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      ...(cookie ? { cookie } : {}),
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            origin: ORIGIN,
            referer: ORIGIN + "/menu/cart",
          }),
    };
    const response = await this.fetcher(url, {
      method,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 25000),
      // Never forward account credentials to a redirect target.
      redirect: "error",
      // Native Node fetch with this Headers serialization was verified live.
      // Passing a plain object with protection fields first returned an edge 429.
      headers: Object.keys(protection).length ? new Headers(headers) : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const value of response.headers.getSetCookie())
      await this.cookieJar.setCookie(value, url.href);
    try {
      return parseResponse(response.status, await response.text());
    } catch (error) {
      if (error instanceof StarbucksError)
        throw new StarbucksError(
          `${method} ${url.pathname}: ${error.message}`,
          error.status,
          error.code,
        );
      throw error;
    }
  }
}
export class StarbucksClient {
  private readonly attemptedOrders = new Set<string>();
  constructor(readonly transport: Transport = new HttpTransport()) {}
  async menu(store?: Store): Promise<Menu> {
    const q = store
      ? new URLSearchParams({
          storeNumber: store.storeNumber.split("-")[0],
          ownershipTypeCode: store.ownershipTypeCode,
          ...(store.timeZone ? { timeZone: store.timeZone.timeZoneId } : {}),
        }).toString()
      : "";
    const data = (await this.transport.request(
      "/apiproxy/v1/ordering/menu" + (q ? "?" + q : ""),
    )) as Menu;
    if (!Array.isArray(data?.menus))
      throw new StarbucksError("Invalid menu response");
    return data;
  }
  async searchMenu(term: string, store?: Store): Promise<MenuProduct[]> {
    const result = new Map<string, MenuProduct>();
    const visit = (nodes: Menu["menus"]) => {
      for (const n of nodes) {
        for (const p of n.products ?? [])
          if (p.name.toLowerCase().includes(term.toLowerCase()))
            result.set(`${p.productNumber}/${p.formCode}`, p);
        visit(n.children ?? []);
      }
    };
    visit((await this.menu(store)).menus);
    return [...result.values()];
  }
  async product(id: number, form = "hot"): Promise<Product> {
    if (!Number.isInteger(id) || id < 1 || !/^[a-z]+$/i.test(form))
      throw new Error("Invalid product id/form");
    const data = (await this.transport.request(
      `/apiproxy/v1/ordering/${id}/${form.toLowerCase()}`,
    )) as { products: Product[] };
    const product = data?.products?.find((p) => p.productNumber === id);
    if (
      !product ||
      !Array.isArray(product.sizes) ||
      !Array.isArray(product.productOptions)
    )
      throw new StarbucksError("Product missing or unsupported");
    return product;
  }
  async stores(
    place: string,
    coordinates?: { lat: number; lng: number },
  ): Promise<StoreLocation[]> {
    const q = new URLSearchParams({ place });
    if (coordinates) {
      if (
        !Number.isFinite(coordinates.lat) ||
        Math.abs(coordinates.lat) > 90 ||
        !Number.isFinite(coordinates.lng) ||
        Math.abs(coordinates.lng) > 180
      )
        throw new Error("Invalid coordinates");
      q.set("lat", String(coordinates.lat));
      q.set("lng", String(coordinates.lng));
    }
    const data = (await this.transport.request(
      "/apiproxy/v1/locations?" + q,
    )) as StoreLocation[];
    if (!Array.isArray(data))
      throw new StarbucksError("Invalid locations response");
    return data;
  }
  async pickupEstimate(storeNumber: string): Promise<PickupEstimate> {
    if (!/^\d+-\d+$/.test(storeNumber))
      throw new Error("Use a full store number, e.g. 114-101752");
    const result = (await this.transport.request(
      "/apiproxy/v1/ordering/pre-order-pickup-estimate/" +
        storeNumber.split("-")[0],
    )) as PickupEstimate;
    if (
      !result ||
      result.locationId !== storeNumber.split("-")[0] ||
      ![
        result.preOrderEstimateMin,
        result.preOrderEstimateMax,
        result.preOrderEstimate,
      ].every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    )
      throw new StarbucksError("Invalid pickup estimate response");
    return result;
  }
  async operation(
    name: string,
    variables: unknown = {},
  ): Promise<Record<string, unknown>> {
    const path = "/apiproxy/v1/orchestra/" + name;
    if (!allowedRequest(path, "POST"))
      throw new Error(
        "Operation is not permitted; order submission is disabled",
      );
    const result = (await this.transport.request(path, { variables })) as {
      data?: Record<string, unknown>;
    };
    if (!result?.data) throw new StarbucksError("API response has no data");
    return result.data;
  }
  async user(): Promise<Record<string, unknown>> {
    const d = await this.operation("get-user");
    if (
      !d.user ||
      typeof d.user !== "object" ||
      !("exId" in d.user) ||
      !d.user.exId
    )
      throw new StarbucksError("Consumer sign-in is required");
    return d.user as Record<string, unknown>;
  }
  async wallet(risk?: OrderRisk): Promise<Record<string, unknown>> {
    const data = await this.operation("get-starpay-wallet", {
      starPayWalletInput: {
        riskInput: {
          platform: "Web",
          market: "US",
          ccAgentName: "WebApp",
          ...(risk ? { deviceFingerprint: risk.deviceFingerprint } : {}),
        },
      },
    });
    if (!data.starPayWallet || typeof data.starPayWallet !== "object")
      throw new StarbucksError(
        "Wallet unavailable; consumer sign-in is required",
      );
    return data.starPayWallet as Record<string, unknown>;
  }

  async transactionHistory({
    offset = 0,
    limit = 50,
  }: HistoryOptions = {}): Promise<TransactionHistory> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error(
        "Invalid history pagination: offset must be nonnegative and limit must be 1–50",
      );
    const data = await this.operation("get-transaction-history", {
      offset,
      limit,
    });
    const history = data.transactionHistoryV2 as TransactionHistory | undefined;
    const paging = history?.paging;
    if (
      !Array.isArray(history?.historyItems) ||
      !paging ||
      ![paging.total, paging.offset, paging.limit, paging.returned].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      paging.offset !== offset ||
      paging.limit !== limit ||
      paging.returned > limit
    )
      throw new StarbucksError("Invalid transaction history response");
    return history;
  }

  async *transactionHistoryPages(
    options: HistoryOptions = {},
  ): AsyncGenerator<TransactionHistory> {
    let offset = options.offset ?? 0;
    for (;;) {
      const page = await this.transactionHistory({ ...options, offset });
      yield page;
      const next = page.paging.offset + page.paging.returned;
      if (next >= page.paging.total) return;
      if (next <= offset)
        throw new StarbucksError("History pagination did not advance");
      offset = next;
    }
  }

  async historyReceipt(historyId: string): Promise<Record<string, unknown>> {
    if (typeof historyId !== "string" || !historyId.trim())
      throw new Error("A history id is required");
    const data = await this.operation("get-history-item-receipt", {
      historyId,
    });
    if (
      !data.activity ||
      typeof data.activity !== "object" ||
      Array.isArray(data.activity)
    )
      throw new StarbucksError("History receipt unavailable");
    return data.activity as Record<string, unknown>;
  }

  async giftOrderHistory(): Promise<Record<string, unknown>[]> {
    const data = (await this.transport.request(
      "/apiproxy/v1/account/history/egift/order-list",
    )) as { orders?: Record<string, unknown>[] };
    if (!Array.isArray(data?.orders))
      throw new StarbucksError("Gift order history unavailable");
    return data.orders;
  }

  async giftOrderDetails(orderId: string): Promise<Record<string, unknown>> {
    if (typeof orderId !== "string" || !orderId.trim())
      throw new Error("An order id is required");
    const data = await this.transport.request(
      "/apiproxy/v1/account/history/egift/order-details",
      { orderId },
    );
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      ("purchaseStatus" in data && data.purchaseStatus === "error")
    )
      throw new StarbucksError("Gift order details unavailable");
    return data as Record<string, unknown>;
  }

  async cards(): Promise<unknown> {
    const d = await this.operation("get-stored-value-card-list");
    return (d.user as Record<string, unknown> | undefined)?.storedValueCardList;
  }
  async rewardPrograms(): Promise<Record<string, unknown>[]> {
    const data = await this.operation("reward-programs");
    if (!Array.isArray(data.rewardPrograms))
      throw new StarbucksError("Reward programs unavailable");
    return data.rewardPrograms;
  }

  async previousOrders(
    storeNumber: string,
    limit = 40,
  ): Promise<Record<string, unknown>[]> {
    if (
      !/^\d+-\d+$/.test(storeNumber) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 40
    )
      throw new Error("Use a full store number and a limit from 1 to 40");
    const data = await this.operation("get-previous-orders", {
      locale: "en-US",
      storeNumber: storeNumber.split("-")[0],
      limit,
    });
    if (!Array.isArray(data.previousOrders))
      throw new StarbucksError("Previous orders unavailable");
    return data.previousOrders;
  }

  async orderPickupTime(
    orderId: string,
    storeNumber: string,
  ): Promise<OrderPickupTime> {
    validateOrderReference(orderId, storeNumber);
    const data = (await this.transport.request(
      `/apiproxy/v1/ordering/pickup-time/${orderId}/${storeNumber.split("-")[0]}`,
    )) as OrderPickupTime;
    if (
      !data ||
      data.orderId !== orderId ||
      data.locationId !== storeNumber.split("-")[0] ||
      typeof data.pickupTime !== "string" ||
      !Number.isFinite(Date.parse(data.pickupTime)) ||
      ![
        data.waitTimeEstimate,
        data.waitTimeEstimateMin,
        data.waitTimeEstimateMax,
      ].every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      )
    )
      throw new StarbucksError(
        "Order pickup estimate unavailable or mismatched",
      );
    return data;
  }

  async orderStatus(
    orderId: string,
    storeNumber: string,
  ): Promise<OrderStatus> {
    return {
      orderId,
      storeNumber,
      status: "pickup-estimate-available",
      pickup: await this.orderPickupTime(orderId, storeNumber),
    };
  }

  /** One attempt only. A timeout or invalid response must be reconciled, never retried. */
  async submitOrder(
    request: SubmitOrderRequest,
    options: { confirm: boolean },
  ): Promise<SubmittedOrder> {
    if (options?.confirm !== true)
      throw new Error("Order submission requires explicit confirmation");
    validateSubmissionRequest(request);
    const { orderId, storeNumber } = request.variables.subInp;
    if (this.attemptedOrders.has(orderId))
      throw new Error("Order submission already attempted; check order status");
    this.attemptedOrders.add(orderId);
    try {
      const response = (await this.transport.request(
        SUBMIT_ORDER_PATH,
        request,
      )) as {
        data?: { submitOrder?: { __typename?: string } };
        errors?: unknown[];
      };
      if (
        response?.errors?.length ||
        response?.data?.submitOrder?.__typename !== "ServiceTime"
      )
        throw new Error("Submission was not acknowledged");
      return {
        state: "submitted",
        orderId,
        storeNumber,
        serviceTime: { __typename: "ServiceTime" },
      };
    } catch (error) {
      if (error instanceof OrderSubmissionDisabledError) {
        this.attemptedOrders.delete(orderId);
        throw error;
      }
      throw new StarbucksError(
        "Submission was not confirmed. Do not resubmit; check order status and history using the prepared order ID.",
      );
    }
  }
  async quote(
    cart: Cart,
    mode: "member" | "guest" = "member",
  ): Promise<PriceQuote> {
    const d = await this.operation(
      mode === "member" ? "price-order" : "price-order-guest",
      { order: toOrder(cart) },
    );
    const quote = d.priceOrder as PriceQuote;
    if (!quote?.summary || typeof quote.summary.price !== "number")
      throw new StarbucksError(
        `Pricing was not successful (${quote?.__typename ?? "unknown response"})`,
      );
    return quote;
  }
}
