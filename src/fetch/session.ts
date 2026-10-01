import fs from "node:fs/promises";
import { Cookie, CookieJar } from "tough-cookie";
import { writePrivate } from "../files.js";

/** Where the fetch client keeps its cookies between runs. */
export interface SessionStore {
  /** Undefined means there is no saved session. */
  load(): Promise<CookieJar | undefined>;
  save(jar: CookieJar): Promise<void>;
}

/** A private JSON file holding a serialized tough-cookie jar. */
export class FileSessionStore implements SessionStore {
  constructor(readonly file: string) {}
  async load(): Promise<CookieJar | undefined> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return await CookieJar.deserialize(JSON.parse(text));
    } catch {
      throw new Error("Invalid HTTP cookie jar");
    }
  }
  async save(jar: CookieJar): Promise<void> {
    await writePrivate(this.file, await jar.serialize());
  }
}

export class MemorySessionStore implements SessionStore {
  constructor(private jar?: CookieJar) {}
  async load(): Promise<CookieJar | undefined> {
    return this.jar;
  }
  async save(jar: CookieJar): Promise<void> {
    this.jar = jar;
  }
}

/** Convert a cookie jar, storage-state object, or cookie export without executing browser code. */
export async function importCookieJar(input: unknown): Promise<CookieJar> {
  if (
    input &&
    typeof input === "object" &&
    "version" in input &&
    typeof input.version === "string" &&
    input.version.startsWith("tough-cookie@")
  ) {
    return CookieJar.deserialize(
      input as Parameters<typeof CookieJar.deserialize>[0],
    );
  }
  const cookies = Array.isArray(input)
    ? input
    : input && typeof input === "object" && "cookies" in input
      ? input.cookies
      : undefined;
  if (!Array.isArray(cookies))
    throw new Error(
      "Expected a cookie jar, storage-state object, or cookie array",
    );
  const jar = new CookieJar();
  for (const c of cookies) {
    if (!c || typeof c.domain !== "string")
      throw new Error("Invalid cookie export");
    const domain = c.domain.replace(/^\./, "");
    if (domain !== "starbucks.com" && !domain.endsWith(".starbucks.com"))
      continue;
    if (
      typeof c.name !== "string" ||
      typeof c.value !== "string" ||
      typeof c.path !== "string" ||
      !c.path.startsWith("/")
    )
      throw new Error("Invalid cookie export");
    const cookie = new Cookie({
      key: c.name,
      value: c.value,
      domain,
      path: c.path,
      hostOnly: !c.domain.startsWith("."),
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      ...(typeof c.expires === "number" && c.expires > 0
        ? { expires: new Date(c.expires * 1000) }
        : {}),
      ...(typeof c.sameSite === "string"
        ? { sameSite: c.sameSite.toLowerCase() }
        : {}),
    });
    await jar.setCookie(cookie, `https://${domain}${c.path}`);
  }
  return jar;
}
