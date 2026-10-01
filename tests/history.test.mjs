import { test } from "bun:test";
import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import { FetchStarbucksClient, MemorySessionStore } from "../dist/index.js";
import { allowedRequest } from "../dist/fetch/policy.js";

const page = (offset, returned, total = 121) => ({
  paging: { offset, limit: 50, returned, total },
  // The server's returned count can differ from the visible item count.
  historyItems: [
    {
      historyId: `fixture-${offset}`,
      historyType: "TransactionWithPoints",
      transactionType: "Purchase",
      date: "2026-09-28",
      historyOverview: { description: "Fixture purchase", price: "$5.00" },
    },
  ],
});

test("history encodes the captured operation and pagination variables", async () => {
  const calls = [];
  const client = new FetchStarbucksClient({
    session: new MemorySessionStore(new CookieJar()),
    fetch: async (url, init) => {
      calls.push({ url: String(url), ...init });
      return Response.json({ data: { transactionHistoryV2: page(0, 50) } });
    },
  });
  const result = await client.transactionHistory();
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://www.starbucks.com/apiproxy/v1/orchestra/get-transaction-history",
  );
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), {
    variables: { offset: 0, limit: 50 },
  });
  assert.equal(result.paging.total, 121);
});

test("history pages advance by paging.returned, not the number of visible records", async () => {
  const offsets = [];
  const client = new FetchStarbucksClient({
    transport: {
      request: async (path, body) => {
        assert.equal(path, "/apiproxy/v1/orchestra/get-transaction-history");
        const offset = body.variables.offset;
        offsets.push(offset);
        return {
          data: {
            transactionHistoryV2: page(offset, offset === 100 ? 21 : 50),
          },
        };
      },
    },
  });
  const received = [];
  for await (const next of client.transactionHistoryPages())
    received.push(next);
  assert.deepEqual(offsets, [0, 50, 100]);
  assert.equal(received.length, 3);
  assert.equal(received.flatMap((p) => p.historyItems).length, 3);
});

test("invalid pagination is rejected locally and non-advancing responses cannot loop", async () => {
  let calls = 0;
  const client = new FetchStarbucksClient({
    transport: {
      request: async () => {
        calls++;
        return { data: { transactionHistoryV2: page(0, 0) } };
      },
    },
  });
  for (const options of [
    { offset: -1 },
    { offset: 1.5 },
    { limit: 0 },
    { limit: 51 },
    { limit: NaN },
  ])
    await assert.rejects(client.transactionHistory(options), /pagination/);
  assert.equal(calls, 0);
  await assert.rejects(async () => {
    for await (const _ of client.transactionHistoryPages()) {
      /* consume until completion */
    }
  }, /advance/);
  assert.equal(calls, 1);
});

test("history response and receipt availability are checked", async () => {
  const client = new FetchStarbucksClient({
    transport: {
      request: async () => ({
        data: { transactionHistoryV2: null, activity: null },
      }),
    },
  });
  await assert.rejects(client.transactionHistory(), /history/i);
  await assert.rejects(client.historyReceipt("fixture-id"), /receipt/i);
  await assert.rejects(client.historyReceipt(""), /history id/i);
});

test("related receipt and eGift reads use their distinct captured-bundle request contracts", async () => {
  const calls = [];
  const client = new FetchStarbucksClient({
    transport: {
      request: async (path, body) => {
        calls.push({ path, body });
        if (path.endsWith("get-history-item-receipt"))
          return { data: { activity: { receipt: { purchasedItems: [] } } } };
        if (path.endsWith("order-list")) return { orders: [] };
        return { purchaseStatus: "complete" };
      },
    },
  });
  await client.historyReceipt("fixture-history");
  assert.deepEqual(await client.giftOrderHistory(), []);
  await client.giftOrderDetails("fixture-order");
  assert.deepEqual(calls, [
    {
      path: "/apiproxy/v1/orchestra/get-history-item-receipt",
      body: { variables: { historyId: "fixture-history" } },
    },
    { path: "/apiproxy/v1/account/history/egift/order-list", body: undefined },
    {
      path: "/apiproxy/v1/account/history/egift/order-details",
      body: { orderId: "fixture-order" },
    },
  ]);
});

test("history read allowlist excludes tipping and order mutations", () => {
  for (const [path, method] of [
    ["/apiproxy/v1/orchestra/get-transaction-history", "POST"],
    ["/apiproxy/v1/orchestra/get-history-item-receipt", "POST"],
    ["/apiproxy/v1/account/history/egift/order-list", "GET"],
    ["/apiproxy/v1/account/history/egift/order-details", "POST"],
  ])
    assert.equal(allowedRequest(path, method), true);
  for (const [path, method] of [
    ["/apiproxy/v1/account/history/set-tip", "POST"],
    ["/apiproxy/v1/account/history/delete-tip/fixture", "DELETE"],
    ["/apiproxy/v1/account/history/egift/order-list", "POST"],
    ["/apiproxy/v1/account/history/egift/order-details", "GET"],
    ["/apiproxy/v1/orchestra/place-order", "POST"],
  ])
    assert.equal(allowedRequest(path, method), false);
});
