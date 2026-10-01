import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CookieJar } from "tough-cookie";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("built CLI starts and exposes auth commands", () => {
  const result = spawnSync(process.execPath, [cli, "auth", "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /import/);
  assert.doesNotMatch(result.stdout, /login/);
});

test("built auth status uses the selected session and verifies the account", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starbucks-cli-"));
  try {
    const session = path.join(dir, "session.json");
    const preload = path.join(dir, "fetch.mjs");
    const jar = new CookieJar();
    await jar.setCookie(
      "session=fixture; Path=/; Secure",
      "https://www.starbucks.com",
    );
    await fs.writeFile(session, JSON.stringify(await jar.serialize()), {
      mode: 0o600,
    });
    await fs.writeFile(
      preload,
      `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), 'https://www.starbucks.com/apiproxy/v1/orchestra/get-user');
        assert.equal(init.method, 'POST');
        assert.equal(new Headers(init.headers).get('cookie'), 'session=fixture');
        assert.deepEqual(JSON.parse(init.body), { variables: {} });
        return Response.json({ data: { user: { exId: 'fixture-user' } } });
      };
    `,
    );
    const result = spawnSync(
      process.execPath,
      ["--preload", preload, cli, "--session", session, "auth", "status"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      authenticated: true,
      session,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
