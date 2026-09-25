import { test } from "bun:test";
import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import { login, importCookieJar } from "../dist/index.js";
const www = "https://www.starbucks.com",
  auth = "https://auth.starbucks.com";
const authorize =
  auth +
  "/authorize?" +
  new URLSearchParams({
    state: "oauth-state",
    redirect_uri: www + "/apiproxy/v1/oauth-callback",
    response_type: "code",
    code_challenge: "synthetic-challenge",
    code_challenge_method: "S256",
  });
const formURL = auth + "/u/login?state=login-state";
const form =
  '<form method="post"><input type="hidden" name="state" value="login-state"><input type="hidden" name="ulp-market" value="U&#83;"><input name="username"><input name="password" type="password"></form>';
const redirect = (location, cookies = []) => {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};
function scenario(overrides = {}) {
  const calls = [];
  const sequence = [
    () => new Response("signin"),
    () =>
      Response.json(authorize, {
        headers: { "set-cookie": "transaction=synthetic; Secure; Path=/" },
      }),
    () =>
      redirect(formURL, ["authsession=synthetic; Secure; HttpOnly; Path=/"]),
    () => new Response(form),
    () => redirect(auth + "/authorize/resume?state=resume-state"),
    () =>
      redirect(
        www +
          "/apiproxy/v1/oauth-callback?code=synthetic-code&state=oauth-state",
      ),
    () =>
      redirect(www + "/account/post-signin?returnUrl=%2F", [
        "member=synthetic; Secure; HttpOnly; Path=/",
      ]),
    () => new Response("signed in"),
    () => Response.json({ data: { user: { exId: "synthetic-user" } } }),
  ];
  return {
    calls,
    fetch: async (url, init) => {
      const index = calls.length;
      calls.push({ url: String(url), ...init });
      assert.equal(init.redirect, index === 8 ? "error" : "manual");
      assert.ok(index < sequence.length, "Unexpected request/retry");
      return (overrides[index] ?? sequence[index])();
    },
  };
}
const credentials = {
  username: "fixture@example.test",
  password: "synthetic-password",
};
test("login uses fresh states, HTML decoding, scoped cookies, redirects, and account verification", async () => {
  const s = scenario(),
    jar = new CookieJar();
  const client = await login(credentials, { fetch: s.fetch, cookieJar: jar });
  assert.equal(client.transport.cookieJar, jar);
  assert.equal(s.calls.length, 9);
  assert.equal(s.calls[1].body, undefined);
  assert.equal(s.calls[2].headers.cookie, undefined);
  const post = s.calls[4];
  assert.equal(post.url, formURL);
  assert.equal(post.method, "POST");
  assert.equal(post.body.get("state"), "login-state");
  assert.equal(post.body.get("ulp-market"), "US");
  assert.equal(post.body.get("password"), credentials.password);
  assert.equal(post.headers.cookie, "authsession=synthetic");
  for (const call of s.calls.slice(5))
    assert.ok(!String(call.body).includes(credentials.password));
  assert.ok(s.calls[8].headers.cookie.includes("member=synthetic"));
  assert.ok(!s.calls[8].headers.cookie.includes("authsession"));
});
test("login rejects external or credential-bearing authorization destinations before fetch", async () => {
  for (const url of [
    "https://evil.example/authorize",
    "https://attacker@auth.starbucks.com/authorize",
  ]) {
    const s = scenario({ 1: () => Response.json(url) });
    await assert.rejects(login(credentials, { fetch: s.fetch }), /destination/);
    assert.equal(s.calls.length, 2);
  }
});
test("login rejects hidden state mismatch before sending credentials", async () => {
  const s = scenario({
    3: () => new Response(form.replace('value="login-state"', 'value="wrong"')),
  });
  await assert.rejects(
    login(credentials, { fetch: s.fetch }),
    /state mismatch/,
  );
  assert.equal(s.calls.length, 4);
});
test("login refuses credential exfiltration and invalid callback state", async () => {
  for (const [index, destination, message] of [
    [4, "https://evil.example/steal", /destination/],
    [
      5,
      www + "/apiproxy/v1/oauth-callback?code=c&state=wrong",
      /callback state/,
    ],
  ]) {
    const s = scenario({ [index]: () => redirect(destination) });
    await assert.rejects(login(credentials, { fetch: s.fetch }), message);
    assert.equal(s.calls.length, index + 1);
  }
});
test("rejection or repeated login form never resubmits credentials", async () => {
  for (const response of [
    new Response("private error", { status: 429 }),
    new Response(form),
  ]) {
    const s = scenario({ 4: () => response });
    await assert.rejects(
      login(credentials, { fetch: s.fetch }),
      /no automatic/,
    );
    assert.equal(s.calls.length, 5);
  }
});
test("login does not replay credentials through a 307 redirect", async () => {
  const s = scenario({
    4: () =>
      new Response(null, {
        status: 307,
        headers: { location: "/authorize/resume" },
      }),
  });
  await assert.rejects(
    login(credentials, { fetch: s.fetch }),
    /credential-preserving/,
  );
  assert.equal(s.calls.length, 5);
});
test("successful redirects are insufficient without an authenticated account", async () => {
  const s = scenario({ 8: () => Response.json({ data: { user: null } }) });
  await assert.rejects(
    login(credentials, { fetch: s.fetch }),
    /sign-in is required/,
  );
});
test("cookie imports preserve host-only/domain scope, expiry, and exclude unrelated domains", async () => {
  const cookies = [
    {
      name: "host",
      value: "one",
      domain: "www.starbucks.com",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: -1,
    },
    {
      name: "shared",
      value: "two",
      domain: ".starbucks.com",
      path: "/",
      sameSite: "Lax",
      expires: -1,
    },
    {
      name: "expired",
      value: "old",
      domain: "www.starbucks.com",
      path: "/",
      expires: 100,
    },
    { name: "foreign", value: "private", domain: "other.example", path: "/" },
  ];
  for (const input of [cookies, { cookies, origins: [] }]) {
    const jar = await importCookieJar(input);
    assert.equal(await jar.getCookieString(auth), "shared=two");
    assert.equal(await jar.getCookieString(www), "host=one; shared=two");
    assert.equal(await jar.getCookieString("https://other.example"), "");
    assert.equal((await jar.getCookies(www))[0].httpOnly, true);
    const copy = await importCookieJar(await jar.serialize());
    assert.equal(await copy.getCookieString(www), "host=one; shared=two");
  }
});
