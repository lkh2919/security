/**
 * Atomic file writes: write a temp file in the same directory, then rename over the target.
 * Readers see either the old or the new complete file, never a partial one.
 * Uses node:fs/promises and path.join only (Bun-compatible, no absolute path assumptions).
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(from: string, to: string): Promise<void> {
  // On Windows a concurrent reader or antivirus scan can make rename fail transiently.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 4 || !RETRYABLE.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { encoding: "utf8" });
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
