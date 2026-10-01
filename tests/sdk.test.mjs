import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  createItem,
  toOrder,
  createCart,
  addItem,
  decreaseItem,
  FetchStarbucksClient,
  parseResponse,
} from "../dist/index.js";
import { allowedRequest } from "../dist/fetch/policy.js";
const load = async (name) =>
  JSON.parse(
    await fs.readFile(new URL("./fixtures/" + name, import.meta.url), "utf8"),
  );
const latte = (await load("latte.json")).products[0];
const observed = await load("latte-price-request.json");
test("latte customization generates the exact observed pricing request", () => {
  const cart = {
    version: 1,
    storeNumber: "114-101752",
    items: [createItem(latte, { size: "Grande", milk: "Oatmilk", shots: 3 })],
  };
  assert.deepEqual({ variables: { order: toOrder(cart) } }, observed);
});
test("default recipe does not charge default milk or shots as customizations", () => {
  const item = createItem(latte, { size: "Grande", milk: "2% Milk", shots: 2 });
  assert.deepEqual(item.modifiers, []);
  assert.equal(item.sku, "42");
});
test("rejects invalid customizations and quantities before requests", () => {
  for (const o of [
    { size: "Trenta" },
    { milk: "Not a milk" },
    { shots: 0 },
    { shots: 3.2 },
    { quantity: -1 },
  ])
    assert.throws(() => createItem(latte, o));
  assert.throws(() =>
    toOrder({ version: 1, storeNumber: "114", items: [createItem(latte)] }),
  );
});
test("local cart merges quantities and decreases without mutating the original", () => {
  const empty = createCart("114-101752");
  const item = createItem(latte, { size: "Grande", milk: "Oatmilk", shots: 3 });
  const one = addItem(empty, item);
  const two = addItem(one, item);
  assert.equal(empty.items.length, 0);
  assert.equal(one.items[0].quantity, 1);
  assert.equal(two.items[0].quantity, 2);
  assert.deepEqual(
    { variables: { order: toOrder(decreaseItem(two, 0)) } },
    observed,
  );
  assert.equal(decreaseItem(one, 0).items.length, 0);
  assert.throws(() => decreaseItem(one, -1));
  assert.throws(() => addItem(one, { ...item, quantity: 20 }));
});
test("SDK guards reject every unapproved financial mutation", () => {
  for (const name of [
    "place-order",
    "submit-order",
    "checkout",
    "reload",
    "charge-card",
    "price-order/../place-order",
  ]) {
    const path = "/apiproxy/v1/orchestra/" + name;
    assert.equal(allowedRequest(path, "POST"), false);
  }
  assert.equal(
    allowedRequest(
      "https://evil.example/apiproxy/v1/orchestra/price-order",
      "POST",
    ),
    false,
  );
  assert.equal(
    allowedRequest("/apiproxy/v1/orchestra/price-order", "POST"),
    true,
  );
  assert.equal(allowedRequest("/apiproxy/v1/ordering/407/hot", "GET"), true);
});
test("order submission cannot reach a transport through the client API", async () => {
  let calls = 0;
  const client = new FetchStarbucksClient({
    transport: {
      request: async () => {
        calls++;
        return {};
      },
    },
  });
  await assert.rejects(client.operation("place-order"), /not permitted/);
  assert.equal(calls, 0);
});
test("HTTP and GraphQL errors cannot masquerade as successful data", () => {
  assert.throws(
    () => parseResponse(429, "{}"),
    (e) => e.status === 429,
  );
  assert.throws(() => parseResponse(200, "<html>Oops</html>"), /non-JSON/);
  assert.throws(
    () => parseResponse(200, '{"errors":[{"message":"unauthorized"}]}'),
    /API errors/,
  );
});

test("anonymous user envelopes do not count as consumer sign-in", async () => {
  const client = new FetchStarbucksClient({
    transport: {
      request: async () => ({ data: { user: {} } }),
    },
  });
  await assert.rejects(client.user(), /sign-in is required/);
});
