import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { CookieJar } from "tough-cookie";
const cli = path.resolve("dist/cli.js");
test("CLI uses only the auth session and ignores obsolete dump-derived context files", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "starbucks-session-only-"),
  );
  try {
    await fs.mkdir(path.join(directory, ".starbucks"));
    await fs.writeFile(
      path.join(directory, ".starbucks/order-request-context.json"),
      "obsolete context must never be read",
    );
    const session = path.join(directory, "session.json");
    const jar = new CookieJar();
    await jar.setCookie(
      "session=fixture; Secure; Path=/",
      "https://www.starbucks.com/",
    );
    await fs.writeFile(session, JSON.stringify(await jar.serialize()));
    const preload = path.join(directory, "preload.mjs");
    await fs.writeFile(
      preload,
      `globalThis.fetch = async (url, init) => {
      if (!String(url).endsWith('/get-user')) throw Error('Unexpected request');
      if (new Headers(init.headers).get('cookie') !== 'session=fixture') throw Error('Wrong session');
      return Response.json({data:{user:{exId:'fixture'}}});
    };`,
    );
    const result = spawnSync(
      process.execPath,
      ["--preload", preload, cli, "--session", session, "auth", "status"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).authenticated, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("CLI and public SDK expose no capture import or context-file requirement", async () => {
  const result = spawnSync(process.execPath, [cli, "order", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /import-context/);
  const sdk = await import("../dist/index.js");
  assert.equal(sdk.importOrderRequestContext, undefined);
});
