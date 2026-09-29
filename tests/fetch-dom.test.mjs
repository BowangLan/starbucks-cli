import { test } from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import { FetchDOM } from "../scripts/fetch-dom.mjs";

test("detached bootstrap can load runtime and contribute fields before form submission", async () => {
  const requested = [];
  const dom = new FetchDOM({
    request: async (url) => {
      requested.push(url.pathname);
      if (url.pathname === "/bootstrap.js")
        return new Response(`
      const script = document.currentScript;
      script.parentNode.removeChild(script);
      document.write('<script src="/runtime.js"><' + '/script>');
    `);
      if (url.pathname === "/runtime.js")
        return new Response(`
      const submit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function () {
        const proof = document.createElement('input');
        proof.type = 'hidden'; proof.name = 'proof'; proof.value = 'fresh-fixture';
        this.appendChild(proof); submit.call(this);
      };
    `);
      throw new Error("Unexpected resource");
    },
  });
  try {
    const window = dom.open(
      '<html><head><script src="/bootstrap.js"></script></head><body><form method="post" action="/u/login"><input name="state" value="fresh-state"></form></body></html>',
      "https://auth.example.test/u/login",
    );
    await dom.settle(30);
    window.document.querySelector("form").submit();
    assert.deepEqual(requested, ["/bootstrap.js", "/runtime.js"]);
    assert.equal(dom.submissions.length, 1);
    assert.equal(dom.submissions[0].fields.get("state"), "fresh-state");
    assert.equal(dom.submissions[0].fields.get("proof"), "fresh-fixture");
    assert.equal(dom.errors.length, 0);
    assert.equal(window.WebSocket, undefined);
  } finally {
    dom.close();
  }
});

test("iframe receives origin-aware messages, registers via fetch XHR, and retains origin storage", async () => {
  const calls = [];
  const dom = new FetchDOM({
    request: async (url, init) => {
      calls.push({ url: url.href, ...init });
      if (url.pathname === "/frame")
        return new Response(`<html><head><script>
      addEventListener('message', event => {
        if (event.origin !== 'https://www.example.test') return;
        const xhr = new XMLHttpRequest();
        xhr.open('post', '/register');
        xhr.addEventListener('load', event => {
          localStorage.setItem('registered', event.target.responseText);
          parent.postMessage('registered', 'https://www.example.test/path');
        });
        xhr.send(event.data);
      });
    </script></head><body></body></html>`);
      if (url.pathname === "/register") return new Response("server-fixture");
      throw new Error("Unexpected resource");
    },
  });
  try {
    const window = dom.open(
      '<html><head></head><body><iframe src="https://context.example.test/frame"></iframe></body></html>',
      "https://www.example.test/path",
    );
    const messages = [];
    window.addEventListener("message", (event) =>
      messages.push({ data: event.data, origin: event.origin }),
    );
    await dom.settle(30);
    const frame = window.document.querySelector("iframe").contentWindow;
    frame.postMessage("wrong-origin", "https://other.example.test");
    frame.postMessage(
      "client-fixture",
      "https://context.example.test/frame?version=1",
    );
    await dom.settle(50);
    const registration = calls.filter((call) => call.url.endsWith("/register"));
    assert.equal(registration.length, 1);
    assert.equal(registration[0].method, "POST");
    assert.equal(registration[0].body, "client-fixture");
    assert.equal(registration[0].origin, "https://context.example.test");
    assert.deepEqual(messages, [
      { data: "registered", origin: "https://context.example.test" },
    ]);
    const next = dom.open("<html></html>", "https://context.example.test/next");
    assert.equal(next.localStorage.getItem("registered"), "server-fixture");
    assert.equal(window.localStorage.getItem("registered"), null);
    assert.equal(dom.errors.length, 0);
  } finally {
    dom.close();
  }
});

test("script cookies share the jar with subsequent auth contexts and beacons use fetch", async () => {
  const jar = new CookieJar(),
    calls = [];
  const dom = new FetchDOM({
    jar,
    request: async (url, init) => {
      calls.push({ url: url.href, ...init });
      return new Response(null, { status: 204 });
    },
  });
  try {
    const first = dom.open("<html></html>", "https://www.example.test/start");
    first.document.cookie =
      "client=fixture; Domain=example.test; Path=/; Secure";
    const second = dom.open(
      "<html></html>",
      "https://auth.example.test/u/login",
    );
    assert.equal(second.document.cookie, "client=fixture");
    assert.equal(await jar.getCookieString("https://unrelated.test/"), "");
    second.navigator.sendBeacon(
      "https://context.example.test/events",
      "fixture-events",
    );
    await dom.settle(1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].origin, "https://auth.example.test");
    assert.equal(calls[0].body, "fixture-events");
  } finally {
    dom.close();
  }
});
