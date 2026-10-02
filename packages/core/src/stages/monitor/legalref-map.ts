/**
 * Loader and helpers for the legal-ref map (`statutes/legalref-map.json`, design C2/C6). A missing file is an empty map: every
 * prefix is then treated as `mapped`, which is the behaviour before the map existed. An invalid file is an error.
 * Accepted file shapes: the bare record `{ "PIPA": {...} }`, or a record wrapped in `entries` / `prefixes` / `map` next to
 * metadata keys (`version`, `generated`, `note`, `$schema`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_LEGALREF_MAP, LegalRefMapSchema, type LegalRefMap, type LegalRefMapEntry } from "../../contracts/legalref-map";

export const LEGALREF_MAP_FILE = join("statutes", "legalref-map.json");
const WRAPPERS = ["entries", "prefixes", "map"] as const;
const META = new Set(["version", "generated", "note", "notes", "$schema", ...WRAPPERS]);

export function parseLegalRefMap(raw: unknown): LegalRefMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("[LEGALREF_MAP] the file must hold a JSON object");
  const obj = raw as Record<string, unknown>;
  const wrapper = WRAPPERS.find((k) => typeof obj[k] === "object" && obj[k] !== null && !Array.isArray(obj[k]));
  const record = wrapper ? obj[wrapper] : Object.fromEntries(Object.entries(obj).filter(([k]) => !META.has(k)));
  const r = LegalRefMapSchema.safeParse(record);
  if (!r.success) throw new Error(`[LEGALREF_MAP] invalid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** `krDir` is `kb/jurisdictions/kr`. */
export function loadLegalRefMap(krDir: string): LegalRefMap {
  const file = join(krDir, LEGALREF_MAP_FILE);
  if (!existsSync(file)) return EMPTY_LEGALREF_MAP;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`[LEGALREF_MAP] ${file} is not readable JSON: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`);
  }
  return parseLegalRefMap(raw);
}

/** Watch-target id of a legal-ref prefix (`PIPA` -> `law:pipa`), or null when the prefix is unknown. */
export function prefixToSourceId(map: LegalRefMap, prefix: string): string | null {
  return map[prefix]?.sourceId ?? null;
}

/** Reverse lookup: the prefix of a watch target (first match in key order), or null. */
export function sourceIdToPrefix(map: LegalRefMap, sourceId: string): string | null {
  return Object.entries(map).find(([, e]) => e.sourceId === sourceId)?.[0] ?? null;
}

export function isManualReviewPrefix(map: LegalRefMap, prefix: string): boolean {
  return map[prefix]?.monitorMode === "manualReview";
}

export const entryOf = (map: LegalRefMap, prefix: string): LegalRefMapEntry | undefined => map[prefix];
