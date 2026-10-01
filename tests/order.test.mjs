import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { CookieJar } from "tough-cookie";
import {
  FetchStarbucksClient,
  MemorySessionStore,
  createItem,
  toOrder,
  prepareOrder,
  orderPayments,
  summarizeOrderPayments,
  buildSubmissionRequest,
  summarizePreparedOrder,
  validatePreparedOrder,
} from "../dist/index.js";
import { allowedRequest } from "../dist/fetch/policy.js";

const fixture = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/order-capture.json", import.meta.url),
    "utf8",
  ),
);
const risk = fixture.submitRequest.variables.risk;
const now = 1_800_000_000_000;
const cart = () => ({
  version: 1,
  storeNumber: fixture.store.storeNumber,
  selectedStore: structuredClone(fixture.store),
  items: [createItem(fixture.product.products[0])],
});
const responses = {
  "get-user": { data: { user: { exId: "fixture-account" } } },
  locations: [{ distance: 0, store: fixture.store }],
  menu: {
    menus: [
      {
        name: "Food",
        children: [],
        products: [
          {
            productNumber: 1033,
            formCode: "Single",
            availability: "Available",
          },
        ],
      },
    ],
  },
  "get-starpay-wallet": fixture.wallet,
  "reward-programs": { data: { rewardPrograms: [] } },
  17011: fixture.estimate,
  "price-order": fixture.priceResponse,
  "submit-order": fixture.submitResponse,
};
function harness(overrides = {}, allowOrderSubmission = false) {
  const calls = [];
  const client = new FetchStarbucksClient({
    session: new MemorySessionStore(new CookieJar()),
    allowOrderSubmission,
    sessionContextFactory: async () => ({
      headers: async () => new Headers(),
      risk: async () => risk,
      close() {},
    }),
    fetch: async (url, init) => {
      const endpoint = new URL(url).pathname;
      const name = endpoint.split("/").at(-1);
      calls.push({ endpoint, body: init.body && JSON.parse(init.body) });
      const key = endpoint.includes("pickup-time") ? "pickup" : name;
      if (overrides[key] instanceof Error) throw overrides[key];
      const value =
        overrides[key] ??
        (key === "pickup" ? fixture.pickupResponse : responses[key]);
      assert.ok(value, `Unexpected network request: ${endpoint}`);
      return Response.json(value);
    },
  });
  return { client, calls };
}
const prepare = (client, options = {}) =>
  prepareOrder(client, cart(), { now: () => now, ...options });

test("captured food cart matches exact price input and preparation stops before submit", async () => {
  assert.deepEqual(
    { variables: { order: toOrder(cart()) } },
    fixture.priceRequest,
  );
  const { client, calls } = harness();
  const prepared = await prepare(client);
  assert.deepEqual(
    calls.map((c) => c.endpoint.split("/").at(-1)),
    [
      "get-user",
      "locations",
      "menu",
      "get-starpay-wallet",
      "reward-programs",
      "17011",
      "price-order",
    ],
  );
  assert.equal(prepared.expiresAt, now + 300_000);
  assert.deepEqual(
    buildSubmissionRequest(prepared, risk, now),
    fixture.submitRequest,
  );
  const summary = summarizePreparedOrder(prepared);
  assert.equal(summary.orderSubmitted, false);
  assert.equal(summary.total, 4.25);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /fixture-paypal|fixture-account|fixture-iovation/,
  );
  assert.equal(calls.length, 7);
});

test("confirmed submission and subsequent status match captured contracts with mock fetch only", async () => {
  const { client, calls } = harness({}, true);
  const prepared = await prepare(client);
  const submitted = await client.submitOrder(
    buildSubmissionRequest(prepared, risk, now),
    { confirm: true },
  );
  assert.equal(submitted.state, "submitted");
  assert.deepEqual(calls.at(-1).body, fixture.submitRequest);
  const status = await client.orderStatus(
    submitted.orderId,
    submitted.storeNumber,
  );
  assert.equal(status.status, "pickup-estimate-available");
  assert.deepEqual(status.pickup, fixture.pickupResponse);
  assert.equal(calls.at(-1).body, undefined);
  assert.match(
    calls.at(-1).endpoint,
    /pickup-time\/11111111-1111-4111-8111-111111111111\/17011$/,
  );
  await assert.rejects(
    client.submitOrder(fixture.submitRequest, { confirm: true }),
    /already attempted/,
  );
  assert.equal(
    calls.filter((c) => c.endpoint.endsWith("submit-order")).length,
    1,
  );
});

test("submission has separate explicit confirmation and HTTP capability gates", async () => {
  const { client, calls } = harness();
  await assert.rejects(
    client.submitOrder(fixture.submitRequest, { confirm: false }),
    /explicit confirmation/,
  );
  await assert.rejects(
    client.submitOrder(fixture.submitRequest, { confirm: true }),
    /disabled.*No order was placed/,
  );
  await assert.rejects(
    client.operation("submit-order", fixture.submitRequest.variables),
    /not permitted/,
  );
  assert.equal(calls.length, 0);
  const path = "/apiproxy/v1/orchestra/submit-order";
  assert.equal(allowedRequest(path, "POST"), false);
  assert.equal(allowedRequest(path, "POST", true), true);
  for (const bad of [
    path + "?extra=1",
    path + "/",
    path.replace("submit-order", "submit-order-guest"),
    "https://evil.example" + path,
    "/apiproxy/v1/orchestra/reload",
  ]) {
    assert.equal(allowedRequest(bad, "POST", true), false);
  }
});

test("ambiguous transport failures and non-success GraphQL unions never retry or report acceptance", async () => {
  for (const failure of [
    new Error("network lost"),
    { errors: [{ message: "secret server detail" }] },
    { data: { submitOrder: { __typename: "OpenAPIError", code: "declined" } } },
    { data: { submitOrder: {} } },
  ]) {
    const { client, calls } = harness({ "submit-order": failure }, true);
    await assert.rejects(
      client.submitOrder(fixture.submitRequest, { confirm: true }),
      /Do not resubmit/,
    );
    await assert.rejects(
      client.submitOrder(fixture.submitRequest, { confirm: true }),
      /already attempted/,
    );
    assert.equal(calls.length, 1);
  }
});

test("expiry, unknown risk, changed quotes, unavailable items, and invalid money fail locally", async () => {
  const { client } = harness();
  const prepared = await prepare(client);
  for (const mutate of [
    (p) => {
      p.expiresAt = now;
    },
    (p) => {
      p.quote.orderId = "not-a-uuid";
    },
    (p) => {
      p.quote.cart.items[0].isAvailable = false;
    },
    (p) => {
      p.quote.cart.items[0].availability = "UNAVAILABLE";
    },
    (p) => {
      p.quote.cart.items[0].quantity = 2;
    },
    (p) => {
      p.cart.items[0].quantity = 2;
    },
    (p) => {
      p.cart.items[0].modifiers.push({ sku: "55", quantity: 1 });
    },
    (p) => {
      p.quote.summary.price = -1;
    },
    (p) => {
      p.quote.summary.price = NaN;
    },
    (p) => {
      p.quote.summary.price = 4.251;
    },
    (p) => {
      p.tipAmount = Infinity;
    },
    (p) => {
      p.state = "submitted";
    },
    (p) => {
      p.quote.currency = "CAD";
    },
  ]) {
    const changed = structuredClone(prepared);
    mutate(changed);
    assert.throws(() => buildSubmissionRequest(changed, risk, now));
  }
  assert.throws(
    () => buildSubmissionRequest(prepared, risk, now + 300_000),
    /expired/,
  );
  assert.throws(
    () => buildSubmissionRequest(prepared, { ...risk, reputation: {} }, now),
    /risk context/,
  );
  assert.throws(
    () =>
      buildSubmissionRequest(prepared, { ...risk, deviceFingerprint: "" }, now),
    /risk context/,
  );
});

test("preparation fails at first unavailable store, product, wallet, or quote", async () => {
  const cases = [
    [{ locations: [{ store: { ...fixture.store, open: false } }] }, 2],
    [{ locations: [{ store: { ...fixture.store, pickUpOptions: [] } }] }, 2],
    [{ menu: { menus: [] } }, 3],
    [
      {
        "get-starpay-wallet": {
          data: {
            starPayWallet: { paymentInstruments: [], storedValueCards: [] },
          },
        },
      },
      4,
    ],
    [
      {
        "price-order": { data: { priceOrder: { __typename: "OpenAPIError" } } },
      },
      7,
    ],
  ];
  for (const [overrides, count] of cases) {
    const { client, calls } = harness(overrides);
    await assert.rejects(prepare(client));
    assert.equal(calls.length, count);
    assert.ok(calls.every((c) => !c.endpoint.includes("submit")));
  }
  const { client, calls } = harness();
  await assert.rejects(prepare(client, { paymentIndex: NaN }), /index/);
  await assert.rejects(
    prepareOrder(client, { ...cart(), selectedStore: undefined }),
    /Select a pickup/,
  );
  assert.equal(calls.length, 0);
});

test("MOP eligibility, default selection, tender mapping, redaction, and SVC balance include tips", async () => {
  const wallet = structuredClone(fixture.wallet.data.starPayWallet);
  wallet.paymentInstruments.push({
    ...wallet.paymentInstruments[0],
    paymentInstrumentId: "reload-only",
    starpayActions: [{ type: "AUTORELOAD", isDefault: true }],
  });
  wallet.paymentInstruments.push({
    ...wallet.paymentInstruments[0],
    paymentInstrumentId: "inactive",
    instrumentStatusCode: "Inactive",
  });
  wallet.storedValueCards.push({
    cardId: "fixture-svc",
    cardNumber: "1234567890123456",
    balance: { amount: 4.25, currency: "USD" },
    starpayActions: [{ type: "MOP", isDefault: false }],
  });
  const payments = orderPayments(wallet);
  assert.equal(payments.length, 2);
  assert.equal(payments[1].tender, "SVC");
  assert.doesNotMatch(
    JSON.stringify(summarizeOrderPayments(payments)),
    /fixture-svc|1234567890123456|fixture-paypal/,
  );
  const { client } = harness({
    "get-starpay-wallet": { data: { starPayWallet: wallet } },
  });
  const prepared = await prepare(client, { paymentIndex: 1 });
  assert.equal(prepared.payment.tender, "SVC");
  assert.equal(
    buildSubmissionRequest(prepared, risk, now).variables.subInp.tenders[0]
      .amount,
    4.25,
  );
  assert.throws(
    () => validatePreparedOrder({ ...prepared, tipAmount: 0.01 }, now),
    /Insufficient/,
  );
  await assert.rejects(
    prepare(client, { paymentIndex: 100 }),
    /eligible payment/,
  );
});

test("status validation rejects mismatched orders and previous orders use the short store number", async () => {
  const { client, calls } = harness({
    pickup: { ...fixture.pickupResponse, orderId: "wrong" },
    "get-previous-orders": { data: { previousOrders: [] } },
  });
  await assert.rejects(
    client.orderStatus(fixture.pickupResponse.orderId, "17011-170949"),
    /mismatched/,
  );
  await assert.rejects(
    client.orderStatus("../submit-order", "17011-170949"),
    /UUID/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(await client.previousOrders("17011-170949"), []);
  assert.deepEqual(calls.at(-1).body, {
    variables: { locale: "en-US", storeNumber: "17011", limit: 40 },
  });
  await assert.rejects(client.previousOrders("17011-170949", 41), /limit/);
});
