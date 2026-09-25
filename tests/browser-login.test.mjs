import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loginWithBrowser } from "../dist/browser-login.js";
const cookie = {
  name: "session",
  value: "synthetic",
  domain: "www.starbucks.com",
  path: "/",
  secure: true,
  httpOnly: true,
  expires: -1,
};
function browserMock({ authenticated = true, pending = false } = {}) {
  const browser = new EventEmitter();
  browser.closed = false;
  browser.close = async () => {
    browser.closed = true;
    browser.emit("disconnected");
  };
  browser.newContext = async () => ({
    cookies: async () => [cookie],
    newPage: async () => ({
      goto: async () => {},
      waitForURL: async (predicate) => {
        assert.equal(
          predicate(new URL("https://auth.starbucks.com/u/login")),
          false,
        );
        assert.equal(
          predicate(new URL("https://evil.example/rewards/my-rewards")),
          false,
        );
        assert.equal(
          predicate(new URL("https://www.starbucks.com/rewards/my-rewards")),
          true,
        );
        if (pending) await new Promise(() => {});
      },
      evaluate: async () => authenticated,
    }),
  });
  return browser;
}
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starbucks-login-"));
  try {
    await fn(path.join(dir, "session.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("browser login verifies account, saves private cookies, then closes", async () =>
  fixture(async (file) => {
    const browser = browserMock();
    const close = browser.close;
    browser.close = async () => {
      assert.ok(JSON.parse(await fs.readFile(file, "utf8")).cookies.length);
      await close();
    };
    const jar = await loginWithBrowser({
      launch: async () => browser,
      sessionFile: file,
    });
    assert.equal(
      await jar.getCookieString("https://www.starbucks.com"),
      "session=synthetic",
    );
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(browser.closed, true);
  }));
test("failed account verification preserves existing session and closes", async () =>
  fixture(async (file) => {
    await fs.writeFile(file, "existing");
    const browser = browserMock({ authenticated: false });
    await assert.rejects(
      loginWithBrowser({ launch: async () => browser, sessionFile: file }),
      /verification failed/,
    );
    assert.equal(await fs.readFile(file, "utf8"), "existing");
    assert.equal(browser.closed, true);
  }));
test("timeout closes browser without saving", async () => {
  const browser = browserMock({ pending: true });
  await assert.rejects(
    loginWithBrowser({ launch: async () => browser, timeoutMs: 20 }),
    /timed out/,
  );
  assert.equal(browser.closed, true);
});
test("cancellation and manual browser closure terminate login", async () => {
  for (const kind of ["cancel", "close"]) {
    const browser = browserMock({ pending: true });
    const controller = new AbortController();
    const pending = loginWithBrowser({
      launch: async () => browser,
      signal: controller.signal,
    });
    setTimeout(
      () =>
        kind === "cancel" ? controller.abort() : browser.emit("disconnected"),
      10,
    );
    await assert.rejects(
      pending,
      kind === "cancel" ? /cancelled/ : /Browser closed/,
    );
    assert.equal(browser.closed, true);
  }
});
