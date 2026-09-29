import fs from "node:fs/promises";
import { Command } from "commander";
import { CookieJar } from "tough-cookie";
import { FetchDOM } from "./fetch-dom.mjs";
import { allowedCheckoutContextRequest } from "./fetch-policy.mjs";
import { writePrivate } from "../src/files.ts";

// This runner generates context only. It cannot call login, pricing, or submit APIs.
const options = new Command()
  .description(
    "Generate fresh checkout risk context using the current vendor scripts; never submit an order",
  )
  .option(
    "--session <file>",
    "existing HTTP cookie jar",
    ".starbucks/http-fetch-session.json",
  )
  .option(
    "--out <file>",
    "private fresh risk context",
    ".starbucks/order-risk.json",
  )
  .parse()
  .opts();
const jar = await CookieJar.deserialize(
  JSON.parse(await fs.readFile(options.session, "utf8")),
);
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const network = [];
let limited = false;
async function request(input, init = {}) {
  const url = new URL(String(input)),
    method = (init.method ?? "GET").toUpperCase();
  if (limited || !allowedCheckoutContextRequest(url, method))
    throw new Error("Checkout context request blocked");
  const headers = new Headers(init.headers);
  headers.set("user-agent", userAgent);
  headers.set("accept-language", "en-US,en;q=0.9");
  if (init.referer) headers.set("referer", init.referer);
  if (init.origin && method === "POST") headers.set("origin", init.origin);
  const cookie = await jar.getCookieString(url.href);
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  const response = await fetch(url, {
    method,
    headers,
    body: init.body,
    redirect: "error",
    signal: AbortSignal.timeout(25000),
  });
  for (const value of response.headers.getSetCookie())
    await jar.setCookie(value, url.href);
  network.push({
    method,
    endpoint: url.origin + url.pathname,
    status: response.status,
  });
  if (response.status === 429) limited = true;
  return response;
}
const dom = new FetchDOM({ request, jar, userAgent });
try {
  const response = await request("https://www.starbucks.com/", {
    document: true,
  });
  if (!response.ok)
    throw new Error(`Context bootstrap returned HTTP ${response.status}`);
  const window = dom.open(
    '<!doctype html><html lang="en-US"><head><script src="/vendor/static/vendor2.js"></script><script src="https://prod.accdab.net/cdn/cs/F3YqEeKYX8DMWEu7kxZT1ymCLP4.js"></script><script src="/weblx/assets/iovation-first-third.js"></script></head><body></body></html>',
    "https://www.starbucks.com/menu/cart",
    (window) => {
      window.IGLOO = {
        loader: { uri_hook: "/iojs", version: "general5" },
        bb_callback(value, complete) {
          window.io_value = value;
          window.io_complete = complete;
        },
      };
    },
  );
  await dom.settle(5500);
  const deviceFingerprint = window.io_value,
    ubaId = window._bcn?.getToken();
  if (!window.io_complete || !deviceFingerprint || !ubaId || limited)
    throw new Error("Fresh checkout context did not complete");
  window._bcn.flush();
  await dom.settle(100);
  if (
    limited ||
    !network.some(
      (entry) =>
        entry.endpoint === "https://prod.accdab.net/beacon/gt" &&
        entry.status === 200,
    )
  )
    throw new Error("Checkout risk registration did not complete");
  const risk = {
    ccAgentName: "WebApp",
    platform: "Web",
    market: "US",
    deviceFingerprint,
    reputation: { deviceFingerprint, ubaId },
  };
  await writePrivate(options.out, risk);
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        file: options.out,
        orderSubmitted: false,
        network,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      error:
        error instanceof Error ? error.message : "Context generation failed",
      orderSubmitted: false,
      network,
    }),
  );
  process.exitCode = 1;
} finally {
  dom.close();
  await writePrivate(options.session, await jar.serialize());
}
