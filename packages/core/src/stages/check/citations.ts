/**
 * Builds the citation table from the rule packs' verified `legalRefs` (until `statutes/citations.json` exists).
 * A citationId is the legal-ref key (`PIPA:30(1)1`); `verifiedAt` is the rule verification date.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CitationTableSchema, type Citation } from "../../contracts/statutes";

export function citationsFromRulePacks(rulePacksDir: string): Citation[] {
  const byId = new Map<string, Citation>();
  for (const pack of existsSync(rulePacksDir) ? readdirSync(rulePacksDir) : []) {
    const dir = join(rulePacksDir, pack);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => /^(S\d\d|T\d\d|A1)\.json$/.test(x))) {
      const sec = JSON.parse(readFileSync(join(dir, f), "utf8")) as { legalRefs?: Record<string, { law: string; article: string; verifiedBy?: unknown; status?: string; effectiveFrom?: string }>; rules: { verifiedAt: string }[] };
      const verifiedAt = sec.rules.map((r) => r.verifiedAt).sort().at(-1) ?? "2026-09-29";
      for (const [id, ref] of Object.entries(sec.legalRefs ?? {})) {
        if (byId.has(id)) continue;
        byId.set(id, {
          citationId: id,
          law: ref.law,
          article: ref.article,
          title: `${ref.law} ${ref.article}`,
          ...(ref.effectiveFrom ? { effectiveFrom: ref.effectiveFrom } : {}),
          sourceId: typeof ref.verifiedBy === "string" ? ref.verifiedBy : `rulepack:${pack}`,
          verifiedAt,
        });
      }
    }
  }
  return CitationTableSchema.parse([...byId.values()].sort((a, b) => (a.citationId < b.citationId ? -1 : 1)));
}

/** Citations for the verified statutory retention table (`statutes/retention-periods.json`): `citationId` as written there. */
export function citationsFromRetention(retentionFile: string): Citation[] {
  if (!existsSync(retentionFile)) return [];
  const t = JSON.parse(readFileSync(retentionFile, "utf8")) as { entries: { statute: string; article: string; paragraph?: string; citationId: string; verifiedBy: { fetched: string }[] }[] };
  const byId = new Map<string, Citation>();
  for (const e of t.entries) {
    if (byId.has(e.citationId) || /[+]/.test(e.citationId)) continue; // combined forms are not single citations
    byId.set(e.citationId, { citationId: e.citationId, law: e.statute, article: e.article, title: `${e.statute} ${e.article}`, sourceId: "retention-periods", verifiedAt: e.verifiedBy[0]?.fetched ?? "2026-09-30" });
  }
  return [...byId.values()];
}

/** Rule-pack legal refs plus the retention table, deduplicated: the table C2 resolves `cite` inlines against. */
export function loadCitations(krDir: string): Citation[] {
  const merged = new Map<string, Citation>();
  for (const c of [...citationsFromRulePacks(join(krDir, "rulepacks")), ...citationsFromRetention(join(krDir, "statutes", "retention-periods.json"))]) if (!merged.has(c.citationId)) merged.set(c.citationId, c);
  return CitationTableSchema.parse([...merged.values()].sort((a, b) => (a.citationId < b.citationId ? -1 : 1)));
}
