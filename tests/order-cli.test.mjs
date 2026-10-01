import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CookieJar } from "tough-cookie";
import { createItem } from "../dist/index.js";
import { nodeExecutable } from "./node-runtime.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/order-capture.json", import.meta.url),
    "utf8",
  ),
);

async function workspace(run, { pickupFails = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starbucks-order-"));
  try {
    await fs.writeFile(path.join(dir, "fixture.json"), JSON.stringify(fixture));
    await fs.writeFile(
      path.join(dir, "session.json"),
      JSON.stringify(await new CookieJar().serialize()),
    );
    await fs.writeFile(
      path.join(dir, "risk.json"),
      JSON.stringify(fixture.submitRequest.variables.risk),
    );
    await fs.writeFile(
      path.join(dir, "cart.json"),
      JSON.stringify({
        version: 1,
        storeNumber: fixture.store.storeNumber,
        selectedStore: fixture.store,
        items: [createItem(fixture.product.products[0])],
      }),
    );
    await fs.writeFile(
      path.join(dir, "fetch.mjs"),
      `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { contextFixture } from '${new URL("./fixtures/context-runtime.mjs", import.meta.url).href}';
      const f = JSON.parse(await fs.readFile('fixture.json', 'utf8'));
      globalThis.fetch = async (url, init) => {
        const contextResponse = contextFixture(url);
        if (contextResponse) return contextResponse;
        const endpoint = new URL(url).pathname;
        await fs.appendFile('network.jsonl', JSON.stringify({ endpoint, method: init.method }) + '\\n');
        const name = endpoint.split('/').at(-1);
        if (endpoint.includes('pickup-time')) {
          ${pickupFails ? 'return new Response("{}", { status: 503 });' : "return Response.json(f.pickupResponse);"}
        }
        const responses = {
          'get-user': { data: { user: { exId: 'fixture-account' } } },
          locations: [{ distance: 0, store: f.store }],
          menu: { menus: [{ name: 'Food', products: [{ productNumber: 1033, formCode: 'Single', availability: 'Available' }], children: [] }] },
          'get-starpay-wallet': f.wallet,
          'reward-programs': { data: { rewardPrograms: [] } },
          '17011': f.estimate,
          'price-order': f.priceResponse,
          'submit-order': f.submitResponse,
        };
        if (name === 'submit-order') assert.deepEqual(JSON.parse(init.body), f.submitRequest);
        assert.ok(responses[name], 'Unexpected endpoint: ' + endpoint);
        return Response.json(responses[name]);
      };
    `,
    );
    const command = (...args) =>
      spawnSync(
        nodeExecutable,
        [
          "--import",
          path.join(dir, "fetch.mjs"),
          cli,
          "--session",
          "session.json",
          "--cart",
          "cart.json",
          "order",
          ...args,
        ],
        { cwd: dir, encoding: "utf8" },
      );
    const calls = async () =>
      (
        await fs
          .readFile(path.join(dir, "network.jsonl"), "utf8")
          .catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    await run({ dir, command, calls });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("CLI prepares and builds a private request without submission or payment-secret output", () =>
  workspace(async ({ dir, command, calls }) => {
    let result = command("review", "--out", "prepared.json");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).orderSubmitted, false);
    assert.doesNotMatch(
      result.stdout,
      /fixture-paypal|fixture-account|fixture-iovation/,
    );
    assert.equal(
      (await fs.stat(path.join(dir, "prepared.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await calls()).length, 7);
    result = command(
      "build-submit",
      "--file",
      "prepared.json",
      "--risk-file",
      "risk.json",
      "--out",
      "request.json",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).networkRequests, 0);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(dir, "request.json"), "utf8")),
      fixture.submitRequest,
    );
    assert.equal(
      (await fs.stat(path.join(dir, "request.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await calls()).length, 7);
    result = command(
      "build-submit",
      "--file",
      "prepared.json",
      "--out",
      "session-request.json",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).contextGenerated, true);
    assert.equal(JSON.parse(result.stdout).orderApiRequests, 0);
    const generated = JSON.parse(
      await fs.readFile(path.join(dir, "session-request.json"), "utf8"),
    );
    assert.equal(
      generated.variables.risk.deviceFingerprint,
      "fixture-current-fingerprint",
    );
    assert.equal((await calls()).length, 7);
    result = command(
      "submit",
      "--file",
      "prepared.json",
      "--risk-file",
      "risk.json",
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --confirm/);
    assert.equal((await calls()).length, 7);
  }));

test("CLI mock submission persists acceptance and prevents a duplicate from a copied draft", () =>
  workspace(async ({ dir, command, calls }) => {
    let result = command("review", "--out", "prepared.json");
    assert.equal(result.status, 0, result.stderr);
    await fs.copyFile(
      path.join(dir, "prepared.json"),
      path.join(dir, "copy.json"),
    );
    result = command(
      "submit",
      "--file",
      "prepared.json",
      "--risk-file",
      "risk.json",
      "--confirm",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "submitted");
    assert.equal(
      JSON.parse(result.stdout).status.status,
      "pickup-estimate-available",
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(dir, "prepared.json"), "utf8"))
        .state,
      "submitted",
    );
    result = command(
      "submit",
      "--file",
      "copy.json",
      "--risk-file",
      "risk.json",
      "--confirm",
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already attempted/);
    assert.equal(
      (await calls()).filter((call) => call.endpoint.endsWith("submit-order"))
        .length,
      1,
    );
  }));

test("CLI preserves submitted state when the mock pickup read fails", () =>
  workspace(
    async ({ dir, command, calls }) => {
      assert.equal(command("review", "--out", "prepared.json").status, 0);
      const result = command(
        "submit",
        "--file",
        "prepared.json",
        "--risk-file",
        "risk.json",
        "--confirm",
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.state, "submitted");
      assert.equal(output.status, "unavailable");
      assert.match(output.note, /without resubmitting/);
      const saved = JSON.parse(
        await fs.readFile(path.join(dir, "prepared.json"), "utf8"),
      );
      assert.equal(saved.state, "submitted");
      assert.equal(
        (await calls()).filter((call) => call.endpoint.endsWith("submit-order"))
          .length,
        1,
      );
    },
    { pickupFails: true },
  ));
