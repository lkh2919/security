/**
 * R4 Clause Matcher: ranks VETTED clauses per applicable section and attaches approved house-style rule ids.
 * Code only (plus the optional Haiku group fallback). The transcript is never read.
 *
 * Coverage of a candidate against the ledger:
 *  - `none`: a condition is known-false (the clause does not fit the facts), or the clause has variables and none is covered;
 *  - `full`: every condition is known-true and every variable slot is filled (code-only rendering is possible);
 *  - `partial`: anything else (unknown condition, some variables missing); `missingVars` lists the uncovered slots.
 * Rank: group match, then coverage (full > partial > none), then corpus frequency, then clause id (stable).
 */
import { ClauseSelectionSchema, VettedClauseRecordSchema, type ClauseSelection } from "../../contracts/clause-selection";
import type { ApplicabilityMap } from "../../contracts/applicability";
import type { FactLedger } from "../../contracts/fact-ledger";
import type { HouseStyleFile } from "../../contracts/house-style";
import type { LlmClient } from "../../llm/client";
import { contextFromLedger, evalCond } from "../coverage/eval-cond";
import { classifyBusinessGroup, type BusinessGroup, type GroupDecision } from "./groups";
import type { ClauseLibrary, LoadedClause } from "./load-clauses";

export interface MatchInput {
  readonly runId: string;
  readonly ledger: FactLedger;
  readonly applicability: ApplicabilityMap;
  readonly library: ClauseLibrary;
  readonly houseStyle: HouseStyleFile;
  /** Document types to match (terms is omitted when not applicable). Default: the applicable ones. */
  readonly docTypes?: readonly ("privacy" | "terms")[];
  readonly llm?: LlmClient;
}

export interface MatchResult {
  readonly selection: ClauseSelection;
  readonly group: GroupDecision;
  /** Sections with no vetted clause at all: drafters write them from the rule pack. */
  readonly sectionsWithoutClause: readonly string[];
  readonly unvettedSkipped: number;
}

const COVERAGE_RANK = { full: 0, partial: 1, none: 2 } as const;

function coverageOf(c: LoadedClause, ledger: FactLedger): { coverage: "full" | "partial" | "none"; missingVars: string[] } {
  const ctx = contextFromLedger(ledger);
  const conds = c.record.conditions.map((cond) => evalCond(cond, ctx));
  const missingVars = [...new Set(c.record.vars.map((v) => v.slotPath))].filter((slot) => {
    const e = ledger.slots[slot];
    return !(e && (e.status === "filled" || e.status === "not_applicable"));
  });
  if (conds.some((x) => x === false)) return { coverage: "none", missingVars };
  const totalVars = new Set(c.record.vars.map((v) => v.slotPath)).size;
  if (totalVars > 0 && missingVars.length === totalVars) return { coverage: "none", missingVars };
  if (conds.every((x) => x === true) && missingVars.length === 0) return { coverage: "full", missingVars };
  return { coverage: "partial", missingVars };
}

export async function runMatch(input: MatchInput): Promise<MatchResult> {
  const { ledger, applicability, library, houseStyle } = input;
  const group = await classifyBusinessGroup(ledger, { llm: input.llm });

  const docs = input.docTypes ?? (["privacy", "terms"] as const).filter((d) => applicability.documents[d].applicable);
  const vetted = library.clauses.filter((c) => VettedClauseRecordSchema.safeParse(c.record).success);
  const unvettedSkipped = library.clauses.length - vetted.length;

  // Only approved house-style rules are attached; candidates are never enforced.
  const approved = houseStyle.rules.filter((r) => r.status === "approved");
  const styleFor = (doc: "privacy" | "terms"): string[] => approved.filter((r) => r.scope === doc || r.scope === "both").map((r) => r.id).sort();

  const sections: ClauseSelection["sections"] = {};
  const without: string[] = [];
  for (const [itemId, item] of Object.entries(applicability.items).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (item.state === "no" || item.state === "pending") continue;
    const doc: "privacy" | "terms" = itemId.startsWith("T") ? "terms" : "privacy";
    if (!docs.includes(doc)) continue;
    const pool = vetted.filter((c) => c.record.docType === doc && c.record.itemIds.includes(itemId));
    const ranked = pool
      .map((c) => ({ c, ...coverageOf(c, ledger), groupMatch: c.domainGroup === group.group ? 0 : c.domainGroup === ("cross_group" satisfies BusinessGroup) ? 1 : 2 }))
      .sort((a, b) => a.groupMatch - b.groupMatch || COVERAGE_RANK[a.coverage] - COVERAGE_RANK[b.coverage] || b.c.frequencyRatio - a.c.frequencyRatio || (a.c.record.clauseId < b.c.record.clauseId ? -1 : 1));
    if (ranked.length === 0) without.push(itemId);
    const style = styleFor(doc);
    sections[itemId] = {
      candidates: ranked.map((r, i) => ({ clauseId: r.c.record.clauseId, rank: i + 1, coverage: r.coverage, missingVars: r.missingVars })),
      styleRefs: [...new Set([...style, ...ranked.flatMap((r) => r.c.record.styleRefs.filter((s) => approved.some((a) => a.id === s)))])].sort(),
    };
  }

  const selection = ClauseSelectionSchema.parse({
    runId: input.runId,
    clauseLibVersion: library.version,
    houseStyleVersion: houseStyle.version ?? (houseStyle.status === "approved" ? "approved" : "candidates-unapproved"),
    businessGroup: group.group,
    groupMethod: group.method,
    sections,
    rationale: `group=${group.group} (${group.basis}); vetted=${vetted.length}/${library.clauses.length}; sections without clause: ${without.join(",") || "none"}`,
  });
  return { selection, group, sectionsWithoutClause: without, unvettedSkipped };
}
