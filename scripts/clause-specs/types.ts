/** Authoring types for the Row 6b clause specs (kb-curator). Text is Korean, normalized, variable-ized. */
export type Cond =
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond }
  | { slot: string; op: "eq" | "in" | "exists" | "truthy"; value?: unknown };

export interface Spec {
  /** Short key, unique per (section, group): becomes the ordinal in the final id. */
  k: string;
  t: "privacy" | "terms";
  /** sectionId (S01..S24, A1, T01..T15) */
  s: string;
  /** domainGroup (cross_group when the pattern is shared across groups) */
  g: string;
  layout?: "legacy_article" | "guideline_numbered";
  /** capture IDs, or "auto" = every eligible capture (docType, group when g != cross_group) whose text matches `m`. */
  sites: string[] | "auto";
  /** Evidence regex source, matched against the whitespace-stripped raw capture text. */
  m: string;
  /** Match against CCTV documents instead of ordinary privacy policies. */
  cctv?: boolean;
  /** Normalized template text (Korean). */
  x: string;
  /** Clause-level applicability (contract Cond). */
  cond?: Cond;
  /** Covered required elements: rule suffixes like "001" (prefixed to R-<section>-001). */
  c: string[];
  /** Gaps vs guideline 2026.4 / rule pack: "001|note" or "|note" (no rule). */
  gp?: string[];
  /** House style tags (H-xx) */
  tg?: string[];
  /** vettingNotes */
  n?: string;
  /** Force-include even if no capture matches (only for pack-derived scaffolding; avoid). */
  allowNoEvidence?: boolean;
}
