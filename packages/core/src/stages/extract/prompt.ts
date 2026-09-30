/**
 * Prompt file loader. Prompt files live in `packages/core/prompts/<stage>/vN.md` with a
 * `version: x.y.z` front-matter line (semver; part of the stage-cache key and of `promptVersion`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PromptFile {
  readonly version: string;
  /** Body without the front matter. Stable text: no timestamps, no run data. */
  readonly body: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

export function parsePromptFile(raw: string, label = "prompt"): PromptFile {
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`[PROMPT] ${label}: missing front matter`);
  const v = /^version:\s*(\S+)\s*$/m.exec(m[1]);
  if (!v || !SEMVER.test(v[1])) throw new Error(`[PROMPT] ${label}: front matter needs "version: x.y.z"`);
  return { version: v[1], body: m[2].trim() };
}

/** `relativePath` is relative to `packages/core/prompts/`, e.g. `extract/v1.md`. */
export function loadPromptFile(relativePath: string): PromptFile {
  const path = fileURLToPath(new URL(`../../../prompts/${relativePath}`, import.meta.url));
  return parsePromptFile(readFileSync(path, "utf8"), relativePath);
}
