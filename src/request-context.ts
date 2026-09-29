import fs from "node:fs/promises";
import path from "node:path";
import { ORIGIN } from "./safety.js";

export const PROTECTION_HEADERS = ["a", "a0", "b", "c", "d", "f", "z"].map(
  (suffix) => "x-dq7hy5l1-" + suffix,
);
const OPERATIONS = ["price-order", "submit-order"] as const;
type ProtectedOperation = (typeof OPERATIONS)[number];
export interface OrderRequestContext {
  version: 1;
  operations: Partial<
    Record<
      ProtectedOperation,
      {
        capturedAt: string;
        headers: Record<string, string>;
      }
    >
  >;
}

/** Only the observed vendor headers are accepted. Never import cookies or arbitrary headers. */
export function validateRequestContext(
  input: unknown,
): asserts input is OrderRequestContext {
  const value = input as OrderRequestContext | undefined;
  if (
    !value ||
    value.version !== 1 ||
    !value.operations ||
    typeof value.operations !== "object" ||
    Array.isArray(value.operations) ||
    !Object.keys(value.operations).length
  )
    throw new Error("Invalid order request context");
  for (const [operation, context] of Object.entries(value.operations)) {
    if (
      !OPERATIONS.includes(operation as ProtectedOperation) ||
      !context ||
      typeof context.capturedAt !== "string" ||
      !Number.isFinite(Date.parse(context.capturedAt)) ||
      !context.headers ||
      typeof context.headers !== "object"
    )
      throw new Error("Invalid protected operation context");
    const entries = Object.entries(context.headers);
    if (
      entries.length !== PROTECTION_HEADERS.length ||
      !PROTECTION_HEADERS.every((name) =>
        Object.hasOwn(context.headers, name),
      ) ||
      entries.some(
        ([name, header]) =>
          !PROTECTION_HEADERS.includes(name) ||
          typeof header !== "string" ||
          !header.length ||
          header.length > 20000 ||
          /[\r\n]/.test(header),
      )
    )
      throw new Error(
        "Request context requires exactly the seven captured protection headers",
      );
  }
}

export function protectedRequestHeaders(
  context: OrderRequestContext | undefined,
  pathname: string,
): Record<string, string> {
  const operation = OPERATIONS.find(
    (name) => pathname === `/apiproxy/v1/orchestra/${name}`,
  );
  return operation ? { ...context?.operations[operation]?.headers } : {};
}

/** Local files only. Select each operation's latest complete successful capture. */
export async function importOrderRequestContext(
  directory: string,
): Promise<OrderRequestContext> {
  const result: OrderRequestContext = { version: 1, operations: {} };
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("tab-")) continue;
    const events = (
      await fs.readFile(
        path.join(directory, entry.name, "events.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const responses = new Map(
      events.filter((e) => e.type === "response").map((e) => [e.id, e]),
    );
    const detailedHeaders = new Map(
      events.filter((e) => e.type === "request-headers").map((e) => [e.id, e]),
    );
    for (const request of events.filter((e) => e.type === "request")) {
      if (
        request.method !== "POST" ||
        responses.get(request.id)?.status !== 200
      )
        continue;
      const url = new URL(request.url);
      const operation = OPERATIONS.find(
        (name) => url.pathname === `/apiproxy/v1/orchestra/${name}`,
      );
      if (!operation || url.origin !== ORIGIN || url.search) continue;
      const headers = new Map<string, string>(
        detailedHeaders
          .get(request.id)
          ?.headers?.map((h: { name: string; value: string }) => [
            h.name.toLowerCase(),
            h.value,
          ]) ?? Object.entries(request.headers),
      );
      if (!PROTECTION_HEADERS.every((name) => headers.has(name))) continue;
      const capturedAt = new Date(request.time).toISOString();
      const previous = result.operations[operation];
      if (previous && Date.parse(previous.capturedAt) > Date.parse(capturedAt))
        continue;
      result.operations[operation] = {
        capturedAt,
        headers: Object.fromEntries(
          PROTECTION_HEADERS.map((name) => [name, headers.get(name)!]),
        ),
      };
    }
  }
  validateRequestContext(result);
  return result;
}
