/**
 * Law watch targets as data (design C4): loads `statutes/law-targets.watch.json` and merges the optional
 * `statutes/law-targets.watch-additions.json` (finance targets with `monitorMode: "manualReview"`). A missing main file falls back to
 * DEFAULT_FRESHNESS_TARGETS; a missing additions file is simply skipped. An unreadable or invalid file is an error: silently
 * dropping a watch target would hide an amendment.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WatchTargetsAdditionsSchema, WatchTargetsFileSchema } from "../../contracts/watch-targets";
import type { FreshnessTargets } from "./run";
import { DEFAULT_FRESHNESS_TARGETS } from "./targets";

export const WATCH_TARGETS_FILE = join("statutes", "law-targets.watch.json");
export const WATCH_ADDITIONS_FILE = join("statutes", "law-targets.watch-additions.json");

export interface LoadedWatchTargets {
  readonly targets: FreshnessTargets;
  /** `file`: the KB file was used; `fallback`: targets.ts. */
  readonly source: "file" | "fallback";
  readonly additionsLoaded: boolean;
  readonly warnings: string[];
}

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`[WATCH_TARGETS] ${what} (${file}) is not readable JSON: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`);
  }
}

function parseOrThrow<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new Error(`[WATCH_TARGETS] ${what} is invalid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
}

/** `krDir` is `kb/jurisdictions/kr`. */
export function loadWatchTargetsDetailed(krDir: string): LoadedWatchTargets {
  const warnings: string[] = [];
  const mainFile = join(krDir, WATCH_TARGETS_FILE);
  let laws: FreshnessTargets["laws"][number][];
  let pages: FreshnessTargets["pages"][number][];
  let source: "file" | "fallback";
  if (existsSync(mainFile)) {
    const main = parseOrThrow(WatchTargetsFileSchema, readJson(mainFile, "law-targets.watch.json"), "law-targets.watch.json");
    laws = [...main.laws];
    pages = [...main.pages];
    source = "file";
  } else {
    laws = [...DEFAULT_FRESHNESS_TARGETS.laws];
    pages = [...DEFAULT_FRESHNESS_TARGETS.pages];
    source = "fallback";
    warnings.push("law-targets.watch.json not found: using the built-in fallback list (stages/freshness/targets.ts)");
  }

  const addFile = join(krDir, WATCH_ADDITIONS_FILE);
  let additionsLoaded = false;
  if (existsSync(addFile)) {
    const add = parseOrThrow(WatchTargetsAdditionsSchema, readJson(addFile, "law-targets.watch-additions.json"), "law-targets.watch-additions.json");
    const seen = new Set([...laws, ...pages].map((t) => t.sourceId));
    for (const t of [...(add.laws ?? []), ...(add.pages ?? [])]) {
      if (seen.has(t.sourceId)) {
        warnings.push(`additions: ${t.sourceId} already exists in the watch list and was ignored`);
        continue;
      }
      seen.add(t.sourceId);
      if ("target" in t) laws.push(t);
      else pages.push(t);
    }
    additionsLoaded = true;
  }
  return { targets: { laws, pages }, source, additionsLoaded, warnings };
}

export function loadWatchTargets(krDir: string): FreshnessTargets {
  return loadWatchTargetsDetailed(krDir).targets;
}
