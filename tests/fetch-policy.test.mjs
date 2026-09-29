import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedContextRequest,
  allowedCheckoutContextRequest,
  retryNotBefore,
} from "../scripts/fetch-policy.mjs";

test("login context allowlist separates credential, registration, script, and read endpoints", () => {
  for (const [url, method] of [
    ["https://auth.starbucks.com/u/login?state=fixture", "POST"],
    ["https://www.starbucks.com/apiproxy/v1/orchestra/get-user", "POST"],
    ["https://prod.accdab.net/beacon/gt?c=fixture", "POST"],
    ["https://prod.accdab.net/beacon/at?c=fixture", "POST"],
    ["https://prod.accdab.net/beacon/et?c=fixture", "POST"],
    ["https://ponos.zeronaught.com/2?a=fixture", "GET"],
    ["https://www.starbucks.com/vendor/static/vendor2.js?seed=fixture", "GET"],
    ["https://mpsnare.iesnare.com/general5/wdp.js", "GET"],
  ])
    assert.equal(allowedContextRequest(new URL(url), method), true, url);
  for (const [url, method] of [
    ["https://prod.accdab.net/u/login", "POST"],
    ["https://www.starbucks.com/u/login", "POST"],
    ["https://auth.starbucks.com/u/login", "PUT"],
    ["https://auth.starbucks.com/vendor/static/vendor2.js", "POST"],
    ["https://www.starbucks.com/apiproxy/v1/ordering/submit", "POST"],
    ["https://www.starbucks.com.evil.test/account/signin", "GET"],
    ["https://attacker@auth.starbucks.com/u/login", "POST"],
    ["https://auth.starbucks.com:8443/u/login", "POST"],
    ["http://auth.starbucks.com/u/login", "POST"],
  ])
    assert.equal(allowedContextRequest(new URL(url), method), false, url);
});

test("checkout context permits protection scripts and registration but no login or order APIs", () => {
  for (const [url, method] of [
    ["https://www.starbucks.com/", "GET"],
    ["https://www.starbucks.com/vendor/static/vendor2.js", "GET"],
    ["https://prod.accdab.net/beacon/gt", "POST"],
    ["https://mpsnare.iesnare.com/general5/wdp.js", "GET"],
  ])
    assert.equal(allowedCheckoutContextRequest(new URL(url), method), true);
  for (const [url, method] of [
    ["https://auth.starbucks.com/u/login", "POST"],
    ["https://www.starbucks.com/apiproxy/v1/orchestra/get-user", "POST"],
    ["https://www.starbucks.com/apiproxy/v1/orchestra/submit-order", "POST"],
    ["https://www.starbucks.com/apiproxy/v1/orchestra/price-order", "POST"],
    ["https://www.starbucks.com/apiproxy/v1/account/a0/signin", "POST"],
    ["https://evil.test/vendor/static/vendor2.js", "GET"],
  ])
    assert.equal(allowedCheckoutContextRequest(new URL(url), method), false);
});

test("cooldown honors seconds and HTTP-date Retry-After without scheduling retries", () => {
  const now = Date.UTC(2026, 8, 29, 1, 0, 0);
  assert.equal(retryNotBefore(null, now), now + 60000);
  assert.equal(retryNotBefore("0", now), now + 60000);
  assert.equal(retryNotBefore("invalid", now), now + 60000);
  assert.equal(retryNotBefore("120", now), now + 120000);
  assert.equal(
    retryNotBefore(new Date(now + 300000).toUTCString(), now),
    now + 300000,
  );
});
