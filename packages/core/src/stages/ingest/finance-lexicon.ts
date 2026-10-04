/**
 * Finance lexicon (design C6): paragraphs that hit it are tagged `financeFlag`. Finance is monitoring only in Phase 1, so a flagged
 * paragraph is never judged against the PIPA packs. Whitespace is ignored on both sides, so "신용 정보" still hits "신용정보".
 * A missing lexicon file means no paragraph is flagged.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IngestedPolicy } from "../../contracts/ingested-policy";

const LexiconFileSchema = z.looseObject({ version: z.string().min(1), terms: z.array(z.string().min(1)).min(1) });

export interface FinanceLexicon {
  readonly version: string;
  /** Terms with whitespace removed. */
  readonly terms: readonly string[];
}

export const EMPTY_FINANCE_LEXICON: FinanceLexicon = { version: "none", terms: [] };

const squash = (s: string): string => s.replace(/\s+/g, "");

export function financeLexiconPath(repoRoot: string): string {
  return join(repoRoot, "kb", "jurisdictions", "kr", "segmentation", "finance-lexicon.json");
}

export function parseFinanceLexicon(raw: string): FinanceLexicon {
  const f = LexiconFileSchema.parse(JSON.parse(raw));
  return { version: f.version, terms: [...new Set(f.terms.map(squash))] };
}

/** Empty lexicon when the file is absent; an invalid file throws. */
export function loadFinanceLexicon(repoRoot: string): FinanceLexicon {
  const file = financeLexiconPath(repoRoot);
  return existsSync(file) ? parseFinanceLexicon(readFileSync(file, "utf8")) : EMPTY_FINANCE_LEXICON;
}

export function hitsFinanceLexicon(lexicon: FinanceLexicon, text: string): boolean {
  if (lexicon.terms.length === 0) return false;
  const t = squash(text);
  return lexicon.terms.some((term) => t.includes(term));
}

/** Returns the policy with `financeFlag: true` on every paragraph that hits the lexicon (other paragraphs are untouched). */
export function tagFinanceParas(policy: IngestedPolicy, lexicon: FinanceLexicon): IngestedPolicy {
  if (lexicon.terms.length === 0) return policy;
  return {
    ...policy,
    sections: policy.sections.map((s) => ({ ...s, paras: s.paras.map((p) => (hitsFinanceLexicon(lexicon, p.text) ? { ...p, financeFlag: true } : p)) })),
  };
}

/** Section ids of `policy` with at least one flagged paragraph, in document order, each once. */
export function financeFlaggedSections(policy: IngestedPolicy): string[] {
  const out: string[] = [];
  for (const s of policy.sections) if (s.paras.some((p) => p.financeFlag) && !out.includes(s.sectionId)) out.push(s.sectionId);
  return out;
}
