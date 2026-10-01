import fs from "node:fs/promises";
import { Command } from "commander";
import { CookieJar } from "tough-cookie";
import { HttpTransport } from "../src/client.ts";
import { writePrivate } from "../src/files.ts";

// Optional diagnostics/export. Normal order commands generate context automatically.
const options = new Command()
  .description(
    "Generate fresh device risk from the auth session; never call an order API",
  )
  .option(
    "--session <file>",
    "HTTP cookie jar",
    ".starbucks/http-fetch-session.json",
  )
  .option("--out <file>", "private risk export", ".starbucks/order-risk.json")
  .parse()
  .opts();
const jar = await CookieJar.deserialize(
  JSON.parse(await fs.readFile(options.session, "utf8")),
);
const transport = new HttpTransport({ cookieJar: jar });
try {
  await writePrivate(options.out, await transport.orderRisk());
  console.log(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      file: options.out,
      orderSubmitted: false,
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Context generation failed",
  );
  process.exitCode = 1;
} finally {
  await transport.close();
  await writePrivate(options.session, await jar.serialize());
}
