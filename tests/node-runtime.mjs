import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve the project's pinned runtime before tests change cwd to isolated temporary folders.
const result = spawnSync("node", ["-p", "process.execPath"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  encoding: "utf8",
});
if (result.status !== 0)
  throw new Error("Node runtime unavailable: " + result.stderr);
export const nodeExecutable = result.stdout.trim();
