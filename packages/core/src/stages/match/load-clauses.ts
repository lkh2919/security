/**
 * Loads the committed clause library (`kb/jurisdictions/kr/clauses/{privacy,terms}/<group>/*.json`) as runtime
 * ClauseRecords. A file that cannot be mapped (unbound variable) is skipped and reported, never guessed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SlotRegistry } from "../../contracts/common";
import type { ClauseRecord } from "../../contracts/clause-selection";
import { KbClauseFileSchema, kbClauseProblems, kbClauseToRecord } from "../../contracts/kb-clause";

export interface LoadedClause {
  readonly record: ClauseRecord;
  readonly domainGroup: string;
  /** Observed frequency in the corpus (`frequency / frequencyBase`), used as a tie-breaker. */
  readonly frequencyRatio: number;
}

export interface ClauseLibrary {
  readonly version: string;
  readonly clauses: readonly LoadedClause[];
  /** Clause ids that were skipped and why. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? walk(join(dir, e)) : [join(dir, e)])) : [];

export function loadClauseLibrary(krDir: string, registry?: SlotRegistry): ClauseLibrary {
  const clausesDir = join(krDir, "clauses");
  const index = JSON.parse(readFileSync(join(clausesDir, "index.json"), "utf8")) as { clauseLibVersion: string };
  const clauses: LoadedClause[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const files = ["privacy", "terms"].flatMap((d) => walk(join(clausesDir, d))).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      skipped.push({ id: f.slice(clausesDir.length + 1), reason: `not valid JSON: ${(e as Error).message.slice(0, 80)}` });
      continue;
    }
    const parsed = KbClauseFileSchema.safeParse(raw);
    if (!parsed.success) {
      skipped.push({ id: f.slice(clausesDir.length + 1), reason: `schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      continue;
    }
    const file = parsed.data;
    const problems = kbClauseProblems(file, registry);
    if (problems.length) {
      skipped.push({ id: file.id, reason: problems.join("; ") });
      continue;
    }
    clauses.push({ record: kbClauseToRecord(file), domainGroup: file.domainGroup, frequencyRatio: file.frequencyBase > 0 ? file.frequency / file.frequencyBase : 0 });
  }
  return { version: index.clauseLibVersion, clauses, skipped };
}
