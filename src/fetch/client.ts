import { CookieJar } from "tough-cookie";
import type {
  LoginCredentials,
  LoginOptions,
  LoginResult,
  StarbucksClient,
} from "../client.js";
import {
  NotSignedInError,
  OrderSubmissionDisabledError,
  StarbucksError,
} from "../errors.js";
import { toOrder } from "../cart.js";
import {
  validateOrderReference,
  validateSubmissionRequest,
} from "../order-validation.js";
import type {
  Cart,
  HistoryOptions,
  Menu,
  MenuProduct,
  OrderPickupTime,
  OrderRisk,
  OrderStatus,
  PickupEstimate,
  PriceQuote,
  Product,
  Store,
  StoreLocation,
  SubmitOrderRequest,
  SubmittedOrder,
  TransactionHistory,
} from "../types.js";
import { allowedRequest, SUBMIT_ORDER_PATH } from "./policy.js";
import { importCookieJar, MemorySessionStore } from "./session.js";
import type { SessionStore } from "./session.js";
import type {
  SessionContext,
  SessionContextOptions,
} from "./session-context.js";
import { HttpTransport, verifyAccount } from "./transport.js";
import type { Transport } from "./transport.js";

export interface FetchClientOptions {
  /** Where cookies load from and save to. Defaults to memory only. */
  session?: SessionStore;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Off by default. Only the exact member submit-order route is enabled. */
  allowOrderSubmission?: boolean;
  /** Optional context implementation for embedding/testing; default uses fresh website scripts. */
  sessionContextFactory?: (
    options: SessionContextOptions,
  ) => Promise<SessionContext>;
  /** Replace the HTTP layer entirely (tests). It then owns authentication. */
  transport?: Transport;
}

/** The StarbucksClient over standard fetch. Owns the cookie jar and its persistence. */
export class FetchStarbucksClient implements StarbucksClient {
  private readonly attemptedOrders = new Set<string>();
  private readonly store: SessionStore;
  private state?: Promise<{ jar: CookieJar; signedIn: boolean }>;
  private http?: Transport;
  private dirty = false;

  constructor(private readonly options: FetchClientOptions = {}) {
    this.store = options.session ?? new MemorySessionStore();
    if (options.transport) {
      this.http = options.transport;
      this.state = Promise.resolve({ jar: new CookieJar(), signedIn: true });
    }
  }

  private session(): Promise<{ jar: CookieJar; signedIn: boolean }> {
    this.state ??= this.store.load().then((jar) => ({
      jar: jar ?? new CookieJar(),
      signedIn: !!jar,
    }));
    return this.state;
  }
  private async transport(): Promise<Transport> {
    const { jar } = await this.session();
    this.http ??= this.httpTransport(jar);
    return this.http;
  }
  private httpTransport(jar: CookieJar): HttpTransport {
    return new HttpTransport({
      cookieJar: jar,
      fetch: this.options.fetch,
      timeoutMs: this.options.timeoutMs,
      allowOrderSubmission: this.options.allowOrderSubmission,
      sessionContextFactory: this.options.sessionContextFactory,
    });
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const result = (await this.transport()).request(path, body);
    // Responses refresh cookies; save them when the client closes.
    this.dirty = true;
    return result;
  }
  private async requireSession(): Promise<void> {
    if (!(await this.session()).signedIn) throw new NotSignedInError();
  }
  private async adopt(jar: CookieJar): Promise<void> {
    await this.http?.close?.();
    this.http = undefined;
    this.state = Promise.resolve({ jar, signedIn: true });
    await this.store.save(jar);
    this.dirty = false;
  }

  async hasSession(): Promise<boolean> {
    return (await this.session()).signedIn;
  }
  async login(
    credentials: LoginCredentials,
    options: LoginOptions = {},
  ): Promise<LoginResult> {
    // A fresh jar: a failed attempt leaves the saved session untouched.
    const jar = new CookieJar();
    const { fetchLogin } = await import("./login.js");
    const result = await fetchLogin(credentials, {
      ...options,
      jar,
      fetch: this.options.fetch,
      timeoutMs: this.options.timeoutMs,
    });
    if (result.authenticated) await this.adopt(jar);
    return result;
  }
  async importSession(input: unknown): Promise<void> {
    const jar = await importCookieJar(input);
    // Verify before replacing the existing session.
    await verifyAccount(this.httpTransport(jar));
    await this.adopt(jar);
  }
  async refreshSession(): Promise<void> {
    await this.requireSession();
    // Stage updates separately so a rejected refresh preserves the saved session.
    const jar = await (await this.session()).jar.clone();
    const result = (await this.httpTransport(jar).request(
      "/apiproxy/v1/orchestra/get-user",
      {},
    )) as { data?: { user?: { exId?: string } } };
    if (!result?.data?.user?.exId)
      throw new StarbucksError(
        "Consumer sign-in is required. Use login or auth import --file <file>.",
      );
    await this.adopt(jar);
  }
  async close(): Promise<void> {
    await this.http?.close?.();
    if (!this.dirty || this.options.transport) return;
    const { jar, signedIn } = await this.session();
    if (signedIn) await this.store.save(jar);
    this.dirty = false;
  }
  async orderRisk(): Promise<OrderRisk> {
    await this.requireSession();
    const transport = await this.transport();
    if (!transport.orderRisk)
      throw new Error("This transport does not generate device risk");
    this.dirty = true;
    return transport.orderRisk();
  }
  async menu(store?: Store): Promise<Menu> {
    const q = store
      ? new URLSearchParams({
          storeNumber: store.storeNumber.split("-")[0],
          ownershipTypeCode: store.ownershipTypeCode,
          ...(store.timeZone ? { timeZone: store.timeZone.timeZoneId } : {}),
        }).toString()
      : "";
    const data = (await this.request(
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
    const data = (await this.request(
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
    const data = (await this.request(
      "/apiproxy/v1/locations?" + q,
    )) as StoreLocation[];
    if (!Array.isArray(data))
      throw new StarbucksError("Invalid locations response");
    return data;
  }
  async pickupEstimate(storeNumber: string): Promise<PickupEstimate> {
    if (!/^\d+-\d+$/.test(storeNumber))
      throw new Error("Use a full store number, e.g. 114-101752");
    const result = (await this.request(
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
  /** A generic allowlisted orchestra read or pricing operation. */
  async operation(
    name: string,
    variables: unknown = {},
  ): Promise<Record<string, unknown>> {
    const path = "/apiproxy/v1/orchestra/" + name;
    if (!allowedRequest(path, "POST"))
      throw new Error(
        "Operation is not permitted; order submission is disabled",
      );
    const result = (await this.request(path, { variables })) as {
      data?: Record<string, unknown>;
    };
    if (!result?.data) throw new StarbucksError("API response has no data");
    return result.data;
  }
  async user(): Promise<Record<string, unknown>> {
    await this.requireSession();
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
    await this.requireSession();
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
    await this.requireSession();
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
    await this.requireSession();
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
    await this.requireSession();
    const data = (await this.request(
      "/apiproxy/v1/account/history/egift/order-list",
    )) as { orders?: Record<string, unknown>[] };
    if (!Array.isArray(data?.orders))
      throw new StarbucksError("Gift order history unavailable");
    return data.orders;
  }

  async giftOrderDetails(orderId: string): Promise<Record<string, unknown>> {
    await this.requireSession();
    if (typeof orderId !== "string" || !orderId.trim())
      throw new Error("An order id is required");
    const data = await this.request(
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
    await this.requireSession();
    const d = await this.operation("get-stored-value-card-list");
    return (d.user as Record<string, unknown> | undefined)?.storedValueCardList;
  }
  async rewardPrograms(): Promise<Record<string, unknown>[]> {
    await this.requireSession();
    const data = await this.operation("reward-programs");
    if (!Array.isArray(data.rewardPrograms))
      throw new StarbucksError("Reward programs unavailable");
    return data.rewardPrograms;
  }

  async previousOrders(
    storeNumber: string,
    limit = 40,
  ): Promise<Record<string, unknown>[]> {
    await this.requireSession();
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
    await this.requireSession();
    validateOrderReference(orderId, storeNumber);
    const data = (await this.request(
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
    await this.requireSession();
    if (options?.confirm !== true)
      throw new Error("Order submission requires explicit confirmation");
    validateSubmissionRequest(request);
    const { orderId, storeNumber } = request.variables.subInp;
    if (this.attemptedOrders.has(orderId))
      throw new Error("Order submission already attempted; check order status");
    this.attemptedOrders.add(orderId);
    try {
      const response = (await this.request(SUBMIT_ORDER_PATH, request)) as {
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
    await this.requireSession();
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
