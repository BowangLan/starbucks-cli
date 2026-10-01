import { CookieJar } from "tough-cookie";
import type { OrderRisk } from "../types.js";
import { OrderSubmissionDisabledError, StarbucksError } from "../errors.js";
import { allowedRequest, ORIGIN, SUBMIT_ORDER_PATH } from "./policy.js";
import type {
  SessionContext,
  SessionContextOptions,
} from "./session-context.js";

/** The single HTTP seam under FetchStarbucksClient; tests may substitute it. */
export interface Transport {
  request(path: string, body?: unknown): Promise<unknown>;
  orderRisk?(): Promise<OrderRisk>;
  close?(): Promise<void>;
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
  /** Optional context implementation for embedding/testing; default uses fresh website scripts. */
  sessionContextFactory?: (
    options: SessionContextOptions,
  ) => Promise<SessionContext>;
  /** Off by default. Only the exact member submit-order route is enabled. */
  allowOrderSubmission?: boolean;
}
/** All network I/O uses standard fetch; cookies follow RFC domain/path/expiry rules. */
export class HttpTransport implements Transport {
  readonly cookieJar: CookieJar;
  private readonly fetcher: typeof globalThis.fetch;
  private context?: Promise<SessionContext>;
  constructor(private readonly options: HttpTransportOptions = {}) {
    this.cookieJar = options.cookieJar ?? new CookieJar();
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  private getContext(): Promise<SessionContext> {
    this.context ??= (async () => {
      const options = {
        cookieJar: this.cookieJar,
        fetch: this.fetcher,
        timeoutMs: this.options.timeoutMs ?? 25000,
      };
      if (this.options.sessionContextFactory)
        return this.options.sessionContextFactory(options);
      const { LiveSessionContext } = await import("./session-context.js");
      return new LiveSessionContext(options);
    })();
    return this.context;
  }
  async orderRisk(): Promise<OrderRisk> {
    return (await this.getContext()).risk();
  }
  async close(): Promise<void> {
    (await this.context)?.close();
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
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    const protectedOperation =
      path === "/apiproxy/v1/orchestra/price-order" ||
      path === SUBMIT_ORDER_PATH;
    const protection = protectedOperation
      ? await (await this.getContext()).headers(path, encodedBody!)
      : undefined;
    const cookie = await this.cookieJar.getCookieString(url.href);
    const headers = {
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
      headers: protection
        ? new Headers({ ...headers, ...Object.fromEntries(protection) })
        : headers,
      body: encodedBody,
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

/** Throws unless the cookies belong to a signed-in member account. */
export async function verifyAccount(transport: Transport): Promise<void> {
  const result = (await transport.request("/apiproxy/v1/orchestra/get-user", {
    variables: {},
  })) as { data?: { user?: { exId?: string } } };
  if (!result?.data?.user?.exId)
    throw new StarbucksError("Consumer sign-in is required");
}
