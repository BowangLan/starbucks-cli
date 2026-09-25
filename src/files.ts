import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function writePrivate(
  file: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
