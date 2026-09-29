import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Command } from "commander";

const command = new Command()
  .description(
    "Inventory all captured requests and API field paths without exposing values; no network access",
  )
  .argument("<capture>", "network-dump capture directory")
  .option(
    "--out <file>",
    "redacted audit report",
    ".starbucks/order-capture-audit.json",
  )
  .parse();
const capture = command.args[0],
  out = command.opts().out;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const normalizePath = (value) =>
  value.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "{id}",
  );
function shape(value) {
  const fields = new Map();
  function visit(item, prefix) {
    const type =
      item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
    const types = fields.get(prefix) ?? new Set();
    types.add(type);
    fields.set(prefix, types);
    if (Array.isArray(item))
      for (const child of item) visit(child, prefix + "[]");
    else if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item))
        visit(child, prefix + "." + key);
  }
  visit(value, "$");
  return Object.fromEntries(
    [...fields]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([field, types]) => [field, [...types].sort()]),
  );
}
const tabs = [],
  hosts = new Map(),
  endpoints = new Map(),
  apiRequests = [];
for (const entry of (await fs.readdir(capture, { withFileTypes: true })).filter(
  (e) => e.isDirectory() && e.name.startsWith("tab-"),
)) {
  const root = path.join(capture, entry.name);
  const raw = await fs.readFile(path.join(root, "events.jsonl"), "utf8");
  const events = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const indexed = (type) =>
    new Map(events.filter((e) => e.type === type).map((e) => [e.id, e]));
  const responses = indexed("response"),
    requestHeaders = indexed("request-headers"),
    bodies = indexed("response-body");
  const requests = events.filter((e) => e.type === "request");
  tabs.push({
    tab: entry.name,
    eventLogSha256: sha256(raw),
    events: events.length,
    requests: requests.length,
    responseBodies: bodies.size,
  });
  for (const request of requests) {
    const url = new URL(request.url);
    hosts.set(url.hostname, (hosts.get(url.hostname) ?? 0) + 1);
    const endpoint =
      request.method + " " + url.origin + normalizePath(url.pathname);
    const group = endpoints.get(endpoint) ?? { endpoint, requests: [] };
    group.requests.push({
      tab: entry.name,
      id: request.id,
      status: responses.get(request.id)?.status ?? null,
    });
    endpoints.set(endpoint, group);
    if (!url.pathname.startsWith("/apiproxy/")) continue;
    const headers = new Map(
      (
        requestHeaders
          .get(request.id)
          ?.headers?.map((h) => [h.name, h.value]) ??
        Object.entries(request.headers)
      ).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const bodyInfo = async (bodyFile) => {
      if (!bodyFile) return { captured: false };
      const bytes = await fs.readFile(path.resolve(root, bodyFile));
      let fields;
      try {
        fields = shape(JSON.parse(bytes.toString("utf8")));
      } catch {
        /* Static map is binary. */
      }
      return {
        captured: true,
        file: bodyFile,
        bytes: bytes.length,
        sha256: sha256(bytes),
        fields,
      };
    };
    apiRequests.push({
      tab: entry.name,
      id: request.id,
      time: request.time,
      endpoint,
      queryParameterNames: [...new Set(url.searchParams.keys())].sort(),
      requestHeaderNames: [...headers.keys()].sort(),
      cookieNames: (headers.get("cookie") ?? "")
        .split(";")
        .map((c) => c.trim().split("=")[0])
        .filter(Boolean)
        .sort(),
      protectionHeaderLengths: Object.fromEntries(
        [...headers]
          .filter(([name]) => name.startsWith("x-dq7hy5l1-"))
          .map(([name, value]) => [name, value.length]),
      ),
      requestBody: await bodyInfo(request.bodyFile),
      status: responses.get(request.id)?.status ?? null,
      responseHeaderNames: Object.keys(
        responses.get(request.id)?.headers ?? {},
      ).sort(),
      responseBody: await bodyInfo(bodies.get(request.id)?.bodyFile),
    });
  }
}
if (!tabs.length) throw new Error("No capture tabs found");
const summary = {
  capture: path.basename(capture),
  tabs,
  requestCount: tabs.reduce((n, tab) => n + tab.requests, 0),
  uniqueEndpointCount: endpoints.size,
  apiRequestCount: apiRequests.length,
  uniqueApiEndpointCount: new Set(apiRequests.map((r) => r.endpoint)).size,
  apiBodiesMissing: apiRequests
    .filter((r) => !r.responseBody.captured)
    .map((r) => `${r.tab}/${r.id}`),
};
await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
await fs.writeFile(
  out,
  JSON.stringify(
    {
      summary,
      hosts: Object.fromEntries([...hosts].sort()),
      endpoints: [...endpoints.values()],
      apiRequests,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify({ ...summary, report: out }, null, 2));
