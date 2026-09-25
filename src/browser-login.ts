import type { Browser } from "playwright";
import { importCookieJar } from "./auth.js";
import { writePrivate } from "./files.js";
import type { CookieJar } from "tough-cookie";

export interface BrowserLoginOptions {
  /** Save a private, atomic cookie jar before closing the browser. */
  sessionFile?: string;
  /** Total time allowed for manual sign-in. Default: five minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional browser launcher for embedding and offline tests. */
  launch?: () => Promise<Browser>;
}

/** User types credentials into the website; no credential reading or recording. */
export async function loginWithBrowser(
  options: BrowserLoginOptions = {},
): Promise<CookieJar> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid login timeout");
  if (options.signal?.aborted) throw new Error("Login cancelled");
  const launch =
    options.launch ??
    (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({ headless: false });
    });
  const browser = await launch();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  let onDisconnect: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Login timed out; session was not saved")),
      timeoutMs,
    );
    onAbort = () => reject(new Error("Login cancelled; session was not saved"));
    onDisconnect = () =>
      reject(new Error("Browser closed before login completed"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    browser.on("disconnected", onDisconnect);
    if (options.signal?.aborted) onAbort();
  });
  try {
    const jar = await Promise.race([
      interrupted,
      (async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        // Register before navigation so a fast callback cannot be missed.
        const completedRedirect = page.waitForURL(
          (url) =>
            url.origin === "https://www.starbucks.com" &&
            url.pathname === "/rewards/my-rewards",
          { timeout: timeoutMs, waitUntil: "domcontentloaded" },
        );
        // Consume early rejection while initial navigation is still pending.
        void completedRedirect.catch(() => {});
        await page.goto(
          "https://www.starbucks.com/account/signin?ReturnUrl=%2Frewards%2Fmy-rewards",
          {
            waitUntil: "domcontentloaded",
            timeout: Math.min(timeoutMs, 60_000),
          },
        );
        await completedRedirect;
        // A redirect alone is not proof of authentication. Verify in the signed-in browser.
        const authenticated = await page.evaluate(async () => {
          const response = await fetch("/apiproxy/v1/orchestra/get-user", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": "application/json",
              "x-requested-with": "XMLHttpRequest",
            },
            body: JSON.stringify({ variables: {} }),
          });
          if (!response.ok) return false;
          const result = await response.json();
          return !result.errors?.length && !!result.data?.user?.exId;
        });
        if (!authenticated)
          throw new Error("Account verification failed; session was not saved");
        return importCookieJar(await context.cookies());
      })(),
    ]);
    if (options.signal?.aborted)
      throw new Error("Login cancelled; session was not saved");
    if (options.sessionFile)
      await writePrivate(options.sessionFile, await jar.serialize());
    return jar;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    browser.off("disconnected", onDisconnect);
    await browser.close().catch(() => {});
  }
}
