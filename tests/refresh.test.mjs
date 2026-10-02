import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CookieJar } from "tough-cookie";
import { FetchStarbucksClient, FileSessionStore } from "../dist/index.js";
import { nodeExecutable } from "./node-runtime.mjs";

const origin = "https://www.starbucks.com";
const cli = path.resolve("dist/cli.js");
async function scenario(run) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "starbucks-refresh-"),
  );
  const file = path.join(directory, "session.json");
  const store = new FileSessionStore(file);
  const jar = new CookieJar();
  await jar.setCookie(".SbuxA0Oat=old; Path=/; Secure; HttpOnly", origin);
  await jar.setCookie("unrelated=secret; Path=/", "https://other.example");
  await jar.setCookie("restricted=secret; Path=/account; Secure", origin);
  await store.save(jar);
  try {
    await run({ directory, file, store, jar });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("refresh sends the captured empty body, scopes cookies, and saves verified updates immediately", () =>
  scenario(async ({ file, store, jar }) => {
    let calls = 0;
    const client = new FetchStarbucksClient({
      session: store,
      sessionContextFactory: async () => {
        throw Error("Refresh must not prepare checkout protection");
      },
      fetch: async (url, init) => {
        calls++;
        assert.equal(String(url), origin + "/apiproxy/v1/orchestra/get-user");
        assert.equal(init.method, "POST");
        assert.equal(init.body, "{}");
        assert.equal(init.redirect, "error");
        assert.equal(new Headers(init.headers).get("cookie"), ".SbuxA0Oat=old");
        return Response.json(
          { data: { user: { exId: "fixture" } } },
          {
            headers: {
              "set-cookie":
                ".SbuxA0Oat=new; Path=/; Secure; HttpOnly; Max-Age=3600",
            },
          },
        );
      },
    });
    await client.refreshSession();
    assert.equal(calls, 1);
    assert.equal(await jar.getCookieString(origin), ".SbuxA0Oat=old");
    const saved = await store.load();
    assert.equal(await saved.getCookieString(origin), ".SbuxA0Oat=new");
    const cookie = (await saved.getCookies(origin))[0];
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.maxAge, 3600);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await client.close();
    assert.equal(
      await (await store.load()).getCookieString(origin),
      ".SbuxA0Oat=new",
    );
  }));

test("failed refresh preserves session bytes even if the response deletes auth cookies, without retry", async () => {
  for (const status of [200, 401, 403, 429, 503]) {
    await scenario(async ({ file, store }) => {
      const before = await fs.readFile(file, "utf8");
      let calls = 0;
      const client = new FetchStarbucksClient({
        session: store,
        fetch: async () => {
          calls++;
          return Response.json(
            { data: { user: null } },
            {
              status,
              headers: {
                "set-cookie": ".SbuxA0Oat=; Path=/; Secure; Max-Age=0",
              },
            },
          );
        },
      });
      await assert.rejects(client.refreshSession());
      await client.close();
      assert.equal(calls, 1);
      assert.equal(await fs.readFile(file, "utf8"), before);
    });
  }
});

test("refresh accepts an authenticated response with no cookie rotation", () =>
  scenario(async ({ store }) => {
    const client = new FetchStarbucksClient({
      session: store,
      fetch: async () => Response.json({ data: { user: { exId: "fixture" } } }),
    });
    await client.refreshSession();
    assert.equal(
      await (await store.load()).getCookieString(origin),
      ".SbuxA0Oat=old",
    );
    await client.close();
  }));

test("CLI auth refresh uses --session, persists cookies, and emits no credentials or profile", () =>
  scenario(async ({ directory, file, store }) => {
    const preload = path.join(directory, "fetch.mjs");
    await fs.writeFile(
      preload,
      `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), 'https://www.starbucks.com/apiproxy/v1/orchestra/get-user');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.equal(init.body, '{}');
        assert.equal(new Headers(init.headers).get('cookie'), '.SbuxA0Oat=old');
        return Response.json({ data: { user: { exId: 'private-id', email: 'private@example.test' } } }, {
          headers: { 'set-cookie': '.SbuxA0Oat=new; Path=/; Secure; HttpOnly' },
        });
      };
    `,
    );
    const result = spawnSync(
      nodeExecutable,
      ["--import", preload, cli, "--session", file, "auth", "refresh"],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, STARBUCKS_USERNAME: "", STARBUCKS_PASSWORD: "" },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      authenticated: true,
      session: file,
    });
    assert.equal(result.stderr, "");
    assert.equal(
      await (await store.load()).getCookieString(origin),
      ".SbuxA0Oat=new",
    );
  }));
