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
} from "./types.js";
import { toOrder } from "./cart.js";
import { allowedRequest, ORIGIN } from "./safety.js";
export class StarbucksError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StarbucksError";
  }
}
export function parseResponse(status: number, body: string): unknown {
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
}
/** All network I/O uses standard fetch; cookies follow RFC domain/path/expiry rules. */
export class HttpTransport implements Transport {
  readonly cookieJar: CookieJar;
  private readonly fetcher: typeof globalThis.fetch;
  constructor(private readonly options: HttpTransportOptions = {}) {
    this.cookieJar = options.cookieJar ?? new CookieJar();
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async request(path: string, body?: unknown): Promise<unknown> {
    const method = body === undefined ? "GET" : "POST";
    if (!allowedRequest(path, method))
      throw new Error(
        "Endpoint is not permitted; order submission is disabled",
      );
    const url = new URL(path, ORIGIN);
    const cookie = await this.cookieJar.getCookieString(url.href);
    const response = await this.fetcher(url, {
      method,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 25000),
      // Never forward account credentials to a redirect target.
      redirect: "error",
      headers: {
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
      },
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
        );
      throw error;
    }
  }
}
export class StarbucksClient {
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
      typeof result.locationId !== "string" ||
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
  async wallet(): Promise<Record<string, unknown>> {
    const data = await this.operation("get-starpay-wallet", {
      starPayWalletInput: {
        riskInput: { platform: "Web", market: "US", ccAgentName: "WebApp" },
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
