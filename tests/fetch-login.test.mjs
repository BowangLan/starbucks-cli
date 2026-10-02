import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CookieJar } from "tough-cookie";
import {
  FetchStarbucksClient,
  FileSessionStore,
  LoginError,
} from "../dist/index.js";

const credentials = {
  username: "fixture@example.test",
  password: "synthetic-password",
};

async function workspace(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "starbucks-login-"));
  try {
    const session = path.join(dir, "session.json");
    const jar = new CookieJar();
    await jar.setCookie(
      "session=existing; Secure; Path=/",
      "https://www.starbucks.com/",
    );
    await fs.writeFile(session, JSON.stringify(await jar.serialize()));
    await run({ dir, session, stateDir: path.join(dir, "fetch-login") });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const savedCookie = async (file) =>
  (
    await CookieJar.deserialize(JSON.parse(await fs.readFile(file, "utf8")))
  ).getCookieString("https://www.starbucks.com/");

test("an active cooldown stops login before any network request", () =>
  workspace(async ({ session, stateDir }) => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "next-attempt.json"),
      JSON.stringify({ notBefore: Date.now() + 60000 }),
    );
    let calls = 0;
    const client = new FetchStarbucksClient({
      session: new FileSessionStore(session),
      fetch: async () => {
        calls++;
        throw Error("Unexpected network request");
      },
    });
    await assert.rejects(
      client.login(credentials, { stateDir }),
      (error) =>
        error instanceof LoginError && /Wait \d+ seconds/.test(error.message),
    );
    assert.equal(calls, 0);
    assert.equal(await savedCookie(session), "session=existing");
  }));

test("a failed login keeps credentials and URLs out of errors and traces, and keeps the saved session", () =>
  workspace(async ({ session, stateDir }) => {
    const client = new FetchStarbucksClient({
      session: new FileSessionStore(session),
      fetch: async () => {
        throw Error(
          `refused ${credentials.username}/${credentials.password} at https://auth.starbucks.com/u/login?state=x`,
        );
      },
    });
    let failure;
    await client.login(credentials, { stateDir }).catch((error) => {
      failure = error;
    });
    assert.ok(failure instanceof LoginError);
    assert.doesNotMatch(
      failure.message,
      /fixture@example|synthetic-password|https?:/,
    );
    await client.close();
    assert.equal(await client.hasSession(), true);
    assert.equal(await savedCookie(session), "session=existing");
    assert.ok(failure.traceFile);
    assert.equal((await fs.stat(failure.traceFile)).mode & 0o777, 0o600);
    const trace = await fs.readFile(failure.traceFile, "utf8");
    assert.doesNotMatch(trace, /synthetic-password|fixture@example/);
    assert.equal(JSON.parse(trace).credentialPosts, 0);
  }));

test("login without stateDir writes no files", () =>
  workspace(async ({ dir, session }) => {
    const before = await fs.readdir(dir);
    const client = new FetchStarbucksClient({
      session: new FileSessionStore(session),
      fetch: async () => {
        throw Error("offline");
      },
    });
    await assert.rejects(client.login(credentials), LoginError);
    assert.deepEqual(await fs.readdir(dir), before);
  }));
