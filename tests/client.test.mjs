import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CookieJar } from "tough-cookie";
import {
  FetchStarbucksClient,
  FileSessionStore,
  NotSignedInError,
} from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const user = () => Response.json({ data: { user: { exId: "fixture" } } });

async function tempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starbucks-client-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function savedJar(file, cookie) {
  const jar = new CookieJar();
  await jar.setCookie(cookie, "https://www.starbucks.com/");
  await fs.writeFile(file, JSON.stringify(await jar.serialize()));
}
async function cookieIn(file) {
  const jar = await CookieJar.deserialize(
    JSON.parse(await fs.readFile(file, "utf8")),
  );
  return jar.getCookieString("https://www.starbucks.com/");
}

test("without a session, browsing works, account reads fail before fetch, and no file is created", () =>
  tempDir(async (dir) => {
    const file = path.join(dir, "session.json");
    const calls = [];
    const client = new FetchStarbucksClient({
      session: new FileSessionStore(file),
      fetch: async (url) => {
        calls.push(new URL(url).pathname);
        return Response.json({ menus: [] });
      },
    });
    assert.equal(await client.hasSession(), false);
    assert.deepEqual(await client.menu(), { menus: [] });
    await assert.rejects(client.user(), NotSignedInError);
    await assert.rejects(client.refreshSession(), NotSignedInError);
    await assert.rejects(client.orderRisk(), /Not signed in/);
    await client.close();
    assert.deepEqual(calls, ["/apiproxy/v1/ordering/menu"]);
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  }));

test("the client sends saved cookies and persists rotated ones privately on close", () =>
  tempDir(async (dir) => {
    const file = path.join(dir, "session.json");
    await savedJar(file, "session=old; Secure; Path=/");
    const client = new FetchStarbucksClient({
      session: new FileSessionStore(file),
      fetch: async (_, init) => {
        assert.equal(new Headers(init.headers).get("cookie"), "session=old");
        return new Response(
          JSON.stringify({ data: { user: { exId: "fixture" } } }),
          { headers: { "set-cookie": "session=new; Secure; Path=/" } },
        );
      },
    });
    assert.equal(await client.hasSession(), true);
    await client.user();
    assert.equal(await cookieIn(file), "session=old");
    await client.close();
    assert.equal(await cookieIn(file), "session=new");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }));

test("importSession verifies the account before replacing the saved session", () =>
  tempDir(async (dir) => {
    const file = path.join(dir, "session.json");
    await savedJar(file, "session=existing; Secure; Path=/");
    const imported = [
      {
        name: "session",
        value: "imported",
        domain: "www.starbucks.com",
        path: "/",
        secure: true,
      },
    ];
    const rejected = new FetchStarbucksClient({
      session: new FileSessionStore(file),
      fetch: async () => Response.json({ data: { user: null } }),
    });
    await assert.rejects(
      rejected.importSession(imported),
      /sign-in is required/,
    );
    await rejected.close();
    assert.equal(await cookieIn(file), "session=existing");

    const accepted = new FetchStarbucksClient({
      session: new FileSessionStore(file),
      fetch: async (_, init) => {
        assert.equal(
          new Headers(init.headers).get("cookie"),
          "session=imported",
        );
        return user();
      },
    });
    await accepted.importSession(imported);
    assert.equal(await accepted.hasSession(), true);
    await accepted.user();
    await accepted.close();
    assert.equal(await cookieIn(file), "session=imported");
  }));

test("CLI reports a missing session and missing login credentials without network", () =>
  tempDir(async (dir) => {
    const preload = path.join(dir, "fetch.mjs");
    await fs.writeFile(
      preload,
      "globalThis.fetch = async () => { throw Error('Unexpected network request'); };",
    );
    const run = (...args) =>
      spawnSync(
        process.execPath,
        ["--preload", preload, cli, "--session", "missing.json", ...args],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            STARBUCKS_USERNAME: "",
            STARBUCKS_PASSWORD: "",
          },
        },
      );
    let result = run("auth", "status");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Not signed in/);
    result = run("login", "--prepare-only");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /STARBUCKS_USERNAME/);
    await assert.rejects(fs.stat(path.join(dir, "missing.json")), {
      code: "ENOENT",
    });
  }));
