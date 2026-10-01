import fs from "node:fs/promises";
import { Command } from "commander";
import { CookieJar } from "tough-cookie";
import { HttpTransport, StarbucksClient } from "../dist/index.js";
import { writePrivate } from "../dist/files.js";
import {
  allowedCheckoutContextRequest,
  retryNotBefore,
} from "./fetch-policy.mjs";

// Diagnostic only: context resources, one wallet read and, if it passes, one price request.
// Neither submission nor status endpoints can pass this transport's allowlist.
const options = new Command()
  .description("Probe live wallet and pricing; never submit or retry")
  .requiredOption("--cart <file>", "local cart to price")
  .option(
    "--session <file>",
    "cookie jar",
    ".starbucks/http-fetch-session.json",
  )
  .option("--risk-file <file>", "fresh optional wallet risk context")
  .option("--out <file>", "redacted report", ".starbucks/order-probe.json")
  .parse()
  .opts();
const jar = await CookieJar.deserialize(
  JSON.parse(await fs.readFile(options.session, "utf8")),
);
const cart = JSON.parse(await fs.readFile(options.cart, "utf8"));
const risk = options.riskFile
  ? JSON.parse(await fs.readFile(options.riskFile, "utf8"))
  : undefined;
const cooldownFile = options.session + ".order-probe-cooldown.json";
let cooldown = {};
try {
  cooldown = JSON.parse(await fs.readFile(cooldownFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const checks = [],
  requests = [],
  attempted = new Set();
const report = {
  checkedAt: new Date().toISOString(),
  checksPassed: false,
  orderSubmitted: false,
  checks,
  requests,
};
let stopped = false;
const client = new StarbucksClient(
  new HttpTransport({
    cookieJar: jar,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const context = allowedCheckoutContextRequest(url, init.method ?? "GET");
      const permitted = new Set([
        "/apiproxy/v1/orchestra/get-starpay-wallet",
        "/apiproxy/v1/orchestra/price-order",
      ]);
      if (stopped || Date.now() < (cooldown.notBefore ?? 0))
        throw new Error(
          "Probe stopped; respect the saved Retry-After cooldown",
        );
      if (
        !context &&
        (url.origin !== "https://www.starbucks.com" ||
          url.search ||
          init.method !== "POST" ||
          !permitted.has(url.pathname) ||
          attempted.has(url.pathname))
      )
        throw new Error(
          "Probe permits one wallet read and one price request only",
        );
      if (!context) attempted.add(url.pathname);
      const response = await fetch(url, init);
      if (!context)
        requests.push({
          endpoint: url.pathname,
          status: response.status,
          responseBytes: (await response.clone().arrayBuffer()).byteLength,
          requestHeaderNames: [...new Headers(init.headers).keys()],
          responseHeaderNames: [...response.headers.keys()],
          server: response.headers.get("server"),
          anticipationLevel: response.headers.get("x-anticipationlevel"),
          ionHop: response.headers.get("x-ion-hop"),
          retryAfter: response.headers.get("retry-after"),
        });
      if (!response.ok) stopped = true;
      if (response.status === 429) {
        cooldown.notBefore = retryNotBefore(
          response.headers.get("retry-after"),
        );
        await writePrivate(cooldownFile, cooldown);
      }
      return response;
    },
  }),
);
try {
  let failure = false;
  for (const [step, run] of [
    [
      "wallet",
      async () => {
        const wallet = await client.wallet(risk);
        if (
          !Array.isArray(wallet.paymentInstruments) ||
          !Array.isArray(wallet.storedValueCards)
        )
          throw new Error("Wallet payment data missing");
        return {
          paymentInstrumentCount: wallet.paymentInstruments.length,
          storedValueCardCount: wallet.storedValueCards.length,
        };
      },
    ],
    [
      "pricing",
      async () => {
        const quote = await client.quote(cart);
        if (
          quote.__typename !== "PricedOrderV2" ||
          !Number.isFinite(quote.summary?.price) ||
          !quote.orderId
        )
          throw new Error("Usable member quote missing");
        return {
          currency: quote.currency,
          total: quote.summary.price,
          expiresIn: quote.expiresIn,
        };
      },
    ],
  ]) {
    if (failure) {
      checks.push({ step, status: "skipped" });
      continue;
    }
    try {
      checks.push({ step, status: "passed", detail: await run() });
    } catch (error) {
      failure = true;
      checks.push({
        step,
        status: "failed",
        error: error.message,
        httpStatus: error.status,
        code: error.code,
      });
    }
  }
  report.checksPassed = !failure;
  if (failure) process.exitCode = 1;
} finally {
  await client.close();
  await writePrivate(options.session, await jar.serialize());
  await writePrivate(options.out, report);
  console.log(JSON.stringify(report, null, 2));
}
