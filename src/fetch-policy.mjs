/** Only the authentication and context endpoints observed in the login capture. */
export function allowedContextRequest(url, method = "GET") {
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
export function allowedCheckoutContextRequest(url, method = "GET") {
  return (
    allowedContextRequest(url, method) &&
    url.hostname !== "auth.starbucks.com" &&
    !url.pathname.startsWith("/apiproxy/")
  );
}

/** Enforce a minimum pause; a longer server Retry-After always wins. No retry is scheduled. */
export function retryNotBefore(value, now = Date.now()) {
  const seconds =
    value && /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : 0;
  const date = value && !seconds ? Date.parse(value) : NaN;
  return Math.max(now + 60000, now + seconds, Number.isFinite(date) ? date : 0);
}
