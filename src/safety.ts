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
