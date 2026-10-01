// Every host and path the fetch client may contact, in one place.
// API calls: allowedRequest. Sign-in redirects: allowedLoginFlowRequest.
// Website and vendor scripts run in jsdom: allowedContextRequest and its checkout subset.
export const ORIGIN = "https://www.starbucks.com";
export const READ_OPERATIONS = new Set([
  "get-user",
  "get-transaction-history",
  "get-history-item-receipt",
  "get-user-mfa-factors",
  "get-privacy-permissions",
  "get-starpay-wallet",
  "get-stored-value-card-list",
  "get-favorite-products",
  "get-previous-orders",
  "get-terms-acknowledgement",
  "reward-programs",
]);
export const PRICE_OPERATIONS = new Set(["price-order", "price-order-guest"]);
export const SUBMIT_ORDER_PATH = "/apiproxy/v1/orchestra/submit-order";
export function allowedRequest(
  url: string,
  method: string,
  allowOrderSubmission = false,
): boolean {
  const u = new URL(url, ORIGIN);
  if (u.origin !== ORIGIN) return false;
  const p = u.pathname;
  if (method === "GET")
    return (
      p === "/apiproxy/v1/account/history/egift/order-list" ||
      /^\/apiproxy\/v1\/ordering\/pickup-time\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\d+$/i.test(
        p,
      ) ||
      /^\/apiproxy\/v1\/(locations|ordering\/menu|ordering\/\d+\/[a-z]+|ordering\/pre-order-pickup-estimate\/\d+)$/.test(
        p,
      )
    );
  if (method === "POST")
    return (
      (allowOrderSubmission && url === SUBMIT_ORDER_PATH) ||
      p === "/apiproxy/v1/account/history/egift/order-details" ||
      (p.startsWith("/apiproxy/v1/orchestra/") &&
        (READ_OPERATIONS.has(p.slice("/apiproxy/v1/orchestra/".length)) ||
          PRICE_OPERATIONS.has(p.slice("/apiproxy/v1/orchestra/".length))))
    );
  return false;
}

export const AUTH_ORIGIN = "https://auth.starbucks.com";
/** Pages the sign-in redirect flow may visit; credentials only ever go to /u/login. */
export function allowedLoginFlowRequest(u: URL): boolean {
  return (
    !u.username &&
    !u.password &&
    ((u.origin === ORIGIN &&
      [
        "/account/signin",
        "/apiproxy/v1/account/a0/signin",
        "/apiproxy/v1/oauth-callback",
        "/account/post-signin",
        "/rewards/my-rewards",
        "/",
      ].includes(u.pathname)) ||
      (u.origin === AUTH_ORIGIN &&
        ["/authorize", "/u/login", "/authorize/resume"].includes(u.pathname)))
  );
}

/** Only the authentication and context endpoints observed in the login capture. */
export function allowedContextRequest(url: URL, method = "GET"): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return false;
  if (method === "POST") {
    return (
      (url.origin === "https://auth.starbucks.com" &&
        url.pathname === "/u/login") ||
      (url.origin === "https://www.starbucks.com" &&
        [
          "/apiproxy/v1/account/a0/signin",
          "/apiproxy/v1/orchestra/get-user",
        ].includes(url.pathname)) ||
      (url.origin === "https://prod.accdab.net" &&
        ["/beacon/gt", "/beacon/at", "/beacon/et"].includes(url.pathname))
    );
  }
  if (method !== "GET") return false;
  if (
    url.origin === "https://www.starbucks.com" &&
    [
      "/",
      "/account/signin",
      "/apiproxy/v1/oauth-callback",
      "/account/post-signin",
      "/rewards/my-rewards",
      "/weblx/assets/iovation-first-third.js",
    ].includes(url.pathname)
  )
    return true;
  if (
    url.origin === "https://auth.starbucks.com" &&
    [
      "/logout",
      "/authorize",
      "/u/login",
      "/authorize/resume",
      "/vendors/accertify.js",
      "/vendors/iovation-first-third.js",
      "/assets/head.js",
      "/assets/body.js",
    ].includes(url.pathname)
  )
    return true;
  if (
    ["https://www.starbucks.com", "https://auth.starbucks.com"].includes(
      url.origin,
    ) &&
    (url.pathname === "/vendor/static/vendor2.js" ||
      /^\/iojs\/[^/]+\/(?:static_wdp|dyn_wdp|logo)\.js$/.test(url.pathname))
  )
    return true;
  if (
    url.origin === "https://prod.accdab.net" &&
    (/^\/cdn\/cs\/[\w.-]+\.js$/.test(url.pathname) ||
      url.pathname === "/beacon/bf/bf.html")
  )
    return true;
  if (url.origin === "https://ponos.zeronaught.com" && url.pathname === "/2")
    return true;
  return (
    url.origin === "https://mpsnare.iesnare.com" &&
    /^\/[^/]+\/(?:wdp|static_wdp|dyn_wdp|logo)\.js$/.test(url.pathname)
  );
}

/** Checkout context generation cannot invoke credentials or any account/order API. */
export function allowedCheckoutContextRequest(
  url: URL,
  method = "GET",
): boolean {
  return (
    allowedContextRequest(url, method) &&
    url.hostname !== "auth.starbucks.com" &&
    !url.pathname.startsWith("/apiproxy/")
  );
}

/** Enforce a minimum pause; a longer server Retry-After always wins. No retry is scheduled. */
export function retryNotBefore(
  value: string | null | undefined,
  now = Date.now(),
): number {
  const seconds =
    value && /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : 0;
  const date = value && !seconds ? Date.parse(value) : NaN;
  return Math.max(now + 60000, now + seconds, Number.isFinite(date) ? date : 0);
}
