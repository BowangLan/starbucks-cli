import fs from "node:fs/promises";
import { Command } from "commander";
import { CookieJar } from "tough-cookie";
import { StarbucksClient, HttpTransport } from "../src/client.ts";
import { writePrivate } from "../src/files.ts";

const command = new Command()
  .name("bun run history")
  .description(
    "Read account history and receipts with an existing HTTP session",
  )
  .option(
    "--session <file>",
    "HTTP cookie jar",
    ".starbucks/http-fetch-session.json",
  )
  .option("--offset <number>", "history offset", "0")
  .option("--limit <number>", "history page size, 1–50", "50")
  .option("--all", "read remaining history pages sequentially")
  .option(
    "--receipt <historyId>",
    "read the receipt for an owned history entry",
  )
  .option("--gifts", "read eGift order history")
  .option("--gift-order <orderId>", "read an owned eGift order")
  .option(
    "--output <file>",
    "save the full result privately; print only a summary",
  )
  .parse();
const options = command.opts();
if (
  [options.all, options.receipt, options.gifts, options.giftOrder].filter(
    Boolean,
  ).length > 1
)
  command.error(
    "Choose only one of --all, --receipt, --gifts, or --gift-order",
  );
let jar;
try {
  jar = await CookieJar.deserialize(
    JSON.parse(await fs.readFile(options.session, "utf8")),
  );
} catch {
  command.error(
    "Missing or invalid session. Run bun run auth:fetch first, or supply --session.",
  );
}
const network = [];
const client = new StarbucksClient(
  new HttpTransport({
    cookieJar: jar,
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      headers.set("referer", "https://www.starbucks.com/account/history");
      headers.set(
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      );
      const response = await fetch(url, { ...init, headers });
      network.push({
        method: init.method,
        endpoint: new URL(url).pathname,
        status: response.status,
      });
      return response;
    },
  }),
);
try {
  let result, summary;
  if (options.receipt) {
    result = await client.historyReceipt(options.receipt);
    summary = { kind: "receipt", found: true };
  } else if (options.gifts) {
    result = await client.giftOrderHistory();
    summary = { kind: "eGift-history", orderCount: result.length };
  } else if (options.giftOrder) {
    result = await client.giftOrderDetails(options.giftOrder);
    summary = { kind: "eGift-order", found: true };
  } else {
    const paging = {
      offset: Number(options.offset),
      limit: Number(options.limit),
    };
    if (options.all) {
      result = { pages: [], historyItems: [] };
      for await (const page of client.transactionHistoryPages(paging)) {
        result.pages.push(page.paging);
        result.historyItems.push(...page.historyItems);
      }
      summary = {
        kind: "history",
        pageCount: result.pages.length,
        itemCount: result.historyItems.length,
        serverTotal: result.pages.at(-1)?.total,
      };
    } else {
      result = await client.transactionHistory(paging);
      summary = {
        kind: "history",
        itemCount: result.historyItems.length,
        paging: result.paging,
      };
    }
  }
  if (options.output) {
    await writePrivate(options.output, result);
    console.log(
      JSON.stringify(
        { ...summary, outputFile: options.output, network },
        null,
        2,
      ),
    );
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "History request failed",
      network,
    }),
  );
  process.exitCode = 1;
} finally {
  await writePrivate(options.session, await jar.serialize());
}
