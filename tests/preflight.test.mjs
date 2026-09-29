import { test } from "bun:test";
import assert from "node:assert/strict";
import { preflight, summarizeWallet, StarbucksError } from "../dist/index.js";

const wallet = {
  paymentInstruments: [
    {
      paymentType: "Visa",
      accountNumberLastFour: "1234",
      default: true,
      instrumentStatusCode: "ACTIVE",
      paymentCode: "private-code",
      scanSeed: "private-seed",
      fullName: "Private Name",
      address: { postalCode: "private-address" },
    },
  ],
  storedValueCards: [{ cardNumber: "private-card-number" }],
  loyaltyIdentifier: "private-loyalty-id",
};

test("wallet summary excludes payment secrets and personal data", () => {
  assert.deepEqual(summarizeWallet(wallet), {
    paymentInstruments: [
      {
        paymentType: "Visa",
        lastFour: "1234",
        default: true,
        status: "ACTIVE",
      },
    ],
    storedValueCardCount: 1,
  });
  assert.throws(() => summarizeWallet({}), /unavailable/);
});

test("preflight performs account, quote, and wallet reads in order", async () => {
  const calls = [],
    cart = { version: 1, storeNumber: "114-101752", items: [] };
  const report = await preflight(
    {
      user: async () => {
        calls.push("account");
        return { exId: "private-account" };
      },
      quote: async (value) => {
        calls.push("quote");
        assert.equal(value, cart);
        return { currency: "USD", summary: { price: 5, priceLabel: "$5.00" } };
      },
      wallet: async () => {
        calls.push("wallet");
        return wallet;
      },
    },
    cart,
  );
  assert.deepEqual(calls, ["account", "quote", "wallet"]);
  assert.equal(report.checksPassed, true);
  assert.equal(report.orderSubmitted, false);
  assert.ok(report.checks.every((check) => check.status === "passed"));
  assert.ok(!JSON.stringify(report).includes("private-"));
});

test("preflight stops network reads after failure and records skipped checks", async () => {
  const calls = [];
  const report = await preflight(
    {
      user: async () => {
        calls.push("account");
        return { exId: "fixture" };
      },
      quote: async () => {
        calls.push("quote");
        throw new StarbucksError("Request rejected", 429);
      },
      wallet: async () => {
        throw new Error("Must not be called");
      },
    },
    { version: 1, storeNumber: "114-101752", items: [] },
  );
  assert.deepEqual(calls, ["account", "quote"]);
  assert.equal(report.checksPassed, false);
  assert.equal(report.orderSubmitted, false);
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ["passed", "failed", "skipped"],
  );
  assert.equal(report.checks[1].httpStatus, 429);
});
