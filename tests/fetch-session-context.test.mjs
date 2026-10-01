import { test } from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import { LiveSessionContext } from "../dist/session-context.js";
import { HttpTransport } from "../dist/client.js";
import { contextFixture } from "./fixtures/context-runtime.mjs";

test("session context executes freshly fetched scripts, scopes cookies, and never sends an API during proof or risk generation", async () => {
  const jar = new CookieJar(),
    calls = [];
  await jar.setCookie(
    "session=auth-only; Secure; HttpOnly; Path=/",
    "https://www.starbucks.com/",
  );
  const context = new LiveSessionContext({
    cookieJar: jar,
    timeoutMs: 1000,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      assert.ok(!url.pathname.startsWith("/apiproxy/"));
      assert.equal(
        new Headers(init.headers).get("cookie"),
        url.origin === "https://www.starbucks.com" ? "session=auth-only" : null,
      );
      const response = contextFixture(url);
      assert.ok(response, "Unexpected context destination");
      return response;
    },
  });
  try {
    const first = await context.headers(
      "/apiproxy/v1/orchestra/price-order",
      "{}",
    );
    const second = await context.headers(
      "/apiproxy/v1/orchestra/submit-order",
      "{}",
    );
    assert.equal(first.get("x-dq7hy5l1-f"), "fixture-bootstrap");
    assert.notEqual(first.get("x-dq7hy5l1-a"), second.get("x-dq7hy5l1-a"));
    const risk = await context.risk();
    assert.equal(risk.deviceFingerprint, "fixture-current-fingerprint");
    assert.equal(risk.reputation.ubaId, "fixture-current-risk");
    assert.ok(
      calls.some((c) => c.url.pathname === "/vendor/static/vendor2.js"),
    );
    await assert.rejects(
      context.headers("/apiproxy/v1/account/signin", "{}"),
      /Unsupported/,
    );
  } finally {
    context.close();
  }
});

test("incomplete fresh proof prevents the pricing request and cannot fall back to a captured file", async () => {
  const calls = [];
  const transport = new HttpTransport({
    timeoutMs: 1000,
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/vendor/static/vendor2.js")
        return new Response('// init("fresh-incomplete")');
      const response = contextFixture(input);
      assert.ok(response, "No application request should be sent");
      return response;
    },
  });
  try {
    await assert.rejects(
      transport.request("/apiproxy/v1/orchestra/price-order", {
        variables: {},
      }),
      /proof is incomplete/,
    );
    assert.ok(!calls.some((p) => p.startsWith("/apiproxy/")));
  } finally {
    await transport.close();
  }
});

test("submission disabled check runs before any context or network request", async () => {
  let calls = 0;
  const transport = new HttpTransport({
    fetch: async () => {
      calls++;
      throw Error("Unexpected");
    },
  });
  await assert.rejects(
    transport.request("/apiproxy/v1/orchestra/submit-order", {}),
    /disabled/,
  );
  assert.equal(calls, 0);
});
