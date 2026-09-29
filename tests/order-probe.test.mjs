import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CookieJar } from "tough-cookie";
import { createItem } from "../dist/index.js";

const fixture = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/order-capture.json", import.meta.url),
    "utf8",
  ),
);
test("diagnostic treats wallet 200 followed by pricing 429 as failure and preserves cooldown", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "starbucks-order-probe-"),
  );
  try {
    const session = path.join(dir, "session.json"),
      cartFile = path.join(dir, "cart.json"),
      report = path.join(dir, "report.json"),
      preload = path.join(dir, "preload.mjs");
    await fs.writeFile(
      session,
      JSON.stringify(await new CookieJar().serialize()),
    );
    const cart = {
      version: 1,
      storeNumber: fixture.store.storeNumber,
      selectedStore: fixture.store,
      items: [createItem(fixture.product.products[0])],
    };
    await fs.writeFile(cartFile, JSON.stringify(cart));
    await fs.writeFile(
      preload,
      `
      let calls = 0;
      globalThis.fetch = async (input, init) => {
        const pathname = new URL(input).pathname;
        if (init.method !== "POST" || ++calls > 2) throw new Error("Unexpected request");
        if (pathname.endsWith("/get-starpay-wallet")) return Response.json({data:{starPayWallet:{paymentInstruments:[],storedValueCards:[]}}});
        if (pathname.endsWith("/price-order")) return new Response("", {status:429,headers:{"retry-after":"120","server":"nginx","x-anticipationlevel":"edge32"}});
        throw new Error("Submission and other endpoints forbidden");
      };
    `,
    );
    const args = [
      "--preload",
      preload,
      "scripts/probe-order.mjs",
      "--session",
      session,
      "--cart",
      cartFile,
      "--out",
      report,
    ];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.checksPassed, false);
    assert.equal(data.orderSubmitted, false);
    assert.deepEqual(
      data.checks.map((c) => [c.step, c.status]),
      [
        ["wallet", "passed"],
        ["pricing", "failed"],
      ],
    );
    assert.equal(data.checks[1].httpStatus, 429);
    assert.equal(data.requests[1].responseBytes, 0);
    assert.equal(data.requests[1].anticipationLevel, "edge32");
    const cooldown = JSON.parse(
      await fs.readFile(session + ".order-probe-cooldown.json", "utf8"),
    );
    assert.ok(cooldown.notBefore > Date.now() + 110000);
    const repeated = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(repeated.status, 1);
    const blocked = JSON.parse(repeated.stdout);
    assert.deepEqual(blocked.requests, []);
    assert.equal(blocked.checks[1].status, "skipped");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
