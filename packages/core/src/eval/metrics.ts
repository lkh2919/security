/**
 * Golden-set metrics and the regression gate (design R11.2). Pure functions: no I/O, no model calls.
 * Thresholds are the design's; `evaluateGate` returns every failed metric so a regression names itself.
 */
import type { ApplicabilityMap } from "../contracts/applicability";
import type { DocAST } from "../contracts/ast";
import { sectionInlines } from "../contracts/ast";
import type { AuditReport } from "../contracts/audit-report";
import type { CheckResults } from "../contracts/check-results";
import type { FactLedger } from "../contracts/fact-ledger";
import type { DefectSpec } from "../contracts/rubric";

export interface ExpectedCase {
  readonly slots: Readonly<Record<string, unknown>>;
  readonly applicability: { readonly documents: { readonly privacy: boolean; readonly terms: boolean }; readonly items: Readonly<Record<string, string>>; readonly warnings: readonly string[] };
}

const canon = (v: unknown): string => JSON.stringify(v);

/** Slot recall and precision of an extracted ledger against the expected slots (filled slots only). */
export function slotScores(expected: ExpectedCase["slots"], ledger: Pick<FactLedger, "slots">): { recall: number; precision: number } {
  const want = Object.entries(expected).filter(([, v]) => v !== "needs_manual_review");
  const got = Object.entries(ledger.slots).filter(([, e]) => e.status === "filled" && e.value !== null);
  const hit = want.filter(([k, v]) => ledger.slots[k]?.status === "filled" && canon(ledger.slots[k]!.value) === canon(v)).length;
  const right = got.filter(([k, e]) => k in expected && canon(expected[k]) === canon(e.value)).length;
  return { recall: want.length === 0 ? 1 : hit / want.length, precision: got.length === 0 ? 1 : right / got.length };
}

/** Share of expected item states, document flags and warning codes that the coverage engine reproduced. */
export function applicabilityAccuracy(expected: ExpectedCase["applicability"], actual: ApplicabilityMap): number {
  let total = 0;
  let ok = 0;
  for (const [id, state] of Object.entries(expected.items)) {
    total += 1;
    if (actual.items[id]?.state === state) ok += 1;
  }
  for (const d of ["privacy", "terms"] as const) {
    total += 1;
    if (actual.documents[d].applicable === expected.documents[d]) ok += 1;
  }
  const codes = new Set(actual.warnings.map((w) => w.code).filter((c) => c !== "TERMS_PACK_PENDING"));
  for (const c of new Set([...expected.warnings, ...codes])) {
    total += 1;
    if (expected.warnings.includes(c) && codes.has(c)) ok += 1;
  }
  return total === 0 ? 1 : ok / total;
}

/** Share of mandatory items (state yes) that the document contains as a usable section. */
export function mandatoryCoverage(ast: DocAST, applicability: ApplicabilityMap, mandatoryIds: readonly string[]): number {
  const need = mandatoryIds.filter((id) => applicability.items[id]?.state === "yes");
  if (need.length === 0) return 1;
  const have = new Set(ast.sections.filter((s) => s.status !== "not_applicable" && s.status !== "omitted_recommended").map((s) => s.id));
  return need.filter((id) => have.has(id)).length / need.length;
}

/** Traceability: drafted sections must record the slots, rules and (when present) clauses behind them. */
export function traceability(ast: DocAST): number {
  const drafted = ast.sections.filter((s) => s.status === "drafted");
  if (drafted.length === 0) return 1;
  const ok = drafted.filter((s) => s.trace.ruleRefs.length > 0 && (s.trace.slotRefs.length > 0 || s.trace.clauseRefs.length > 0 || s.blocks.every((b) => b.t === "note"))).length;
  return ok / drafted.length;
}

/** Share of `cite` inlines that resolved (C2 `evidence.citations`). 1 when the document cites nothing. */
export function citationValidity(ast: DocAST, c2: CheckResults): number {
  let cites = 0;
  for (const s of ast.sections) for (const i of sectionInlines(s)) if (i.t === "cite") cites += 1;
  if (cites === 0) return 1;
  const bad = c2.checks.find((c) => c.checkId === "evidence.citations")?.findings.length ?? 0;
  return Math.max(0, (cites - bad) / cites);
}

/** Count of unsupported claims: slotRefs that are not filled ledger slots plus broken ledger evidence. */
export function unsupportedClaims(c2: CheckResults): number {
  return ["evidence.slot_refs", "evidence.transcript_quotes"].reduce((n, id) => n + (c2.checks.find((c) => c.checkId === id)?.findings.length ?? 0), 0);
}

/** Share of sections rendered by code (no LLM) among sections drafted with content. */
export function clauseFirstRatio(clauseSections: readonly string[], llmSections: readonly string[]): number {
  const total = clauseSections.length + llmSections.length;
  return total === 0 ? 0 : clauseSections.length / total;
}

/** A seeded defect is detected when the report holds a finding for the expected rule in the expected section. */
export function defectDetected(spec: DefectSpec, report: Pick<AuditReport, "findings">): boolean {
  return report.findings.some((f) => f.ruleId === spec.expected.ruleId && (f.sectionId === spec.expected.sectionId || spec.expected.docType === "cross"));
}

export function defectRecall(results: readonly { spec: DefectSpec; detected: boolean }[]): number {
  return results.length === 0 ? 1 : results.filter((r) => r.detected).length / results.length;
}

/** Text similarity in [0, 1]: Dice coefficient over character bigrams of the whitespace-normalized text. */
export function textSimilarity(a: string, b: string): number {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const x = grams(norm(a));
  const y = grams(norm(b));
  let inter = 0;
  for (const [g, n] of x) inter += Math.min(n, y.get(g) ?? 0);
  const total = [...x.values()].reduce((p, q) => p + q, 0) + [...y.values()].reduce((p, q) => p + q, 0);
  return total === 0 ? 1 : (2 * inter) / total;
}

/** Stability across runs: same section ids and table row counts, and the minimum pairwise text similarity. */
export function stability(runs: readonly DocAST[], text: (ast: DocAST) => string): { sameStructure: boolean; minSimilarity: number } {
  const shape = (a: DocAST): string => JSON.stringify(a.sections.map((s) => [s.id, s.status, s.blocks.filter((b) => b.t === "table").map((b) => (b.t === "table" ? b.rows.length : 0))]));
  const base = runs[0];
  if (!base) return { sameStructure: true, minSimilarity: 1 };
  let min = 1;
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) min = Math.min(min, textSimilarity(text(runs[i]!), text(runs[j]!)));
  return { sameStructure: runs.every((r) => shape(r) === shape(base)), minSimilarity: min };
}

// ---------------------------------------------------------------------------------------------------------------------

export interface GateMetrics {
  readonly applicabilityAccuracy: number;
  readonly mandatoryCoverage: number;
  readonly traceability: number;
  readonly citationValidity: number;
  readonly unsupportedClaims: number;
  readonly slotRecall: number;
  readonly slotPrecision: number;
  readonly defectRecall: number;
  /** Blocker + major findings on the final report of every G case. */
  readonly blockingFindings: number;
  readonly sameStructure: boolean;
  readonly minSimilarity: number;
  readonly clauseFirstRatio: number;
  /** Relative cost change against the baseline (0.1 = +10%); undefined when there is no baseline. */
  readonly costDelta?: number;
  readonly latencyDelta?: number;
}

export interface GateFailure {
  readonly metric: string;
  readonly value: number | boolean;
  readonly threshold: string;
}

export const GATE_THRESHOLDS = {
  applicabilityAccuracy: 1,
  mandatoryCoverage: 1,
  traceability: 1,
  citationValidity: 1,
  unsupportedClaims: 0,
  slotRecall: 0.9,
  slotPrecision: 0.95,
  defectRecall: 0.9,
  blockingFindings: 0,
  minSimilarity: 0.85,
  costRegression: 0.25,
} as const;

/** Design R11.2. `clauseFirstRatio` is tracked (target 0.5) but never fails the gate. */
export function evaluateGate(m: GateMetrics): GateFailure[] {
  const t = GATE_THRESHOLDS;
  const fails: GateFailure[] = [];
  const min = (metric: keyof GateMetrics, v: number, th: number): void => {
    if (v < th) fails.push({ metric, value: v, threshold: `>= ${th}` });
  };
  min("applicabilityAccuracy", m.applicabilityAccuracy, t.applicabilityAccuracy);
  min("mandatoryCoverage", m.mandatoryCoverage, t.mandatoryCoverage);
  min("traceability", m.traceability, t.traceability);
  min("citationValidity", m.citationValidity, t.citationValidity);
  min("slotRecall", m.slotRecall, t.slotRecall);
  min("slotPrecision", m.slotPrecision, t.slotPrecision);
  min("defectRecall", m.defectRecall, t.defectRecall);
  min("minSimilarity", m.minSimilarity, t.minSimilarity);
  if (m.unsupportedClaims > t.unsupportedClaims) fails.push({ metric: "unsupportedClaims", value: m.unsupportedClaims, threshold: `<= ${t.unsupportedClaims}` });
  if (m.blockingFindings > t.blockingFindings) fails.push({ metric: "blockingFindings", value: m.blockingFindings, threshold: `<= ${t.blockingFindings}` });
  if (!m.sameStructure) fails.push({ metric: "sameStructure", value: false, threshold: "same sections and table rows across runs" });
  for (const k of ["costDelta", "latencyDelta"] as const) {
    const v = m[k];
    if (v !== undefined && v > t.costRegression) fails.push({ metric: k, value: v, threshold: `<= ${t.costRegression}` });
  }
  return fails;
}
