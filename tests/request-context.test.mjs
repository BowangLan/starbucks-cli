import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  importOrderRequestContext,
  validateRequestContext,
  HttpTransport,
} from "../dist/index.js";

const headers = Object.fromEntries(
  ["a", "a0", "b", "c", "d", "f", "z"].map((s) => [
    "x-dq7hy5l1-" + s,
    "fixture-" + s,
  ]),
);
const context = () => ({
  version: 1,
  operations: {
    "price-order": {
      capturedAt: "2026-09-29T02:10:00Z",
      headers: { ...headers },
    },
  },
});
test("request context rejects arbitrary headers, unknown operations, missing proof, and line breaks", () => {
  for (const change of [
    (value) => {
      value.operations["price-order"].headers.cookie = "old-session";
    },
    (value) => {
      value.operations["get-user"] = value.operations["price-order"];
    },
    (value) => {
      delete value.operations["price-order"].headers["x-dq7hy5l1-f"];
    },
    (value) => {
      value.operations["price-order"].headers["x-dq7hy5l1-f"] = "bad\r\nvalue";
    },
  ]) {
    const value = context();
    change(value);
    assert.throws(() => validateRequestContext(value));
    assert.throws(() => new HttpTransport({ requestContext: value }));
  }
});
test("capture import selects the latest successful operation and never imports account cookies", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starbucks-context-"));
  try {
    await fs.mkdir(path.join(dir, "tab-001"));
    const events = [];
    for (const [id, status, host] of [
      ["1", 200, "www.starbucks.com"],
      ["2", 200, "www.starbucks.com"],
      ["3", 429, "www.starbucks.com"],
      ["4", 200, "other.example"],
    ]) {
      events.push(
        {
          type: "request",
          id,
          time: `2026-09-29T02:10:0${id}Z`,
          method: "POST",
          url: `https://${host}/apiproxy/v1/orchestra/price-order`,
          headers: {},
        },
        { type: "response", id, status },
        {
          type: "request-headers",
          id,
          headers: Object.entries({
            ...headers,
            "x-dq7hy5l1-f": "proof-" + id,
            cookie: "account-secret",
            authorization: "secret",
          }).map(([name, value]) => ({ name, value })),
        },
      );
    }
    await fs.writeFile(
      path.join(dir, "tab-001/events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n"),
    );
    const result = await importOrderRequestContext(dir);
    assert.equal(
      result.operations["price-order"].headers["x-dq7hy5l1-f"],
      "proof-2",
    );
    assert.equal(
      Object.keys(result.operations["price-order"].headers).length,
      7,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /account-secret|authorization|cookie/,
    );
    assert.equal(result.operations["submit-order"], undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
