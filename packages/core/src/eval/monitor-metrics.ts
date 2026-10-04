/**
 * Policy Monitor and Peer Watch evaluation metrics (design M8, confirmed design C7). Pure functions: no I/O, no model calls.
 * `scripts/eval-gates.ts` feeds them with monitor output and golden labels; `evaluateMonitorGates` applies the designs' thresholds
 * and returns one row per gate. A gate whose input was not measured is `skip` (never a silent pass, never a failure): for example
 * the real-policy slice before it exists, or LLM-only seeds when the run was deterministic.
 */

export const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 5, high: 4, medium: 3, low: 2, confirm: 1 };

// --- contracts of the labels (golden/monitor) ------------------------------------------------------------------------

export interface SectionLabel {
  readonly title: string;
  readonly sectionId: string;
  /** Other ids that are also right, for a combined heading such as "처리 목적, 항목 및 보유기간". */
  readonly alsoAccept?: readonly string[];
}

export interface FindingLike {
  readonly ruleId: string;
  readonly sectionId: string;
  readonly severity: string;
  readonly location?: { readonly para: number | null; readonly quote: string };
}

export interface ExpectedFinding {
  readonly ruleId?: string;
  /** Any of these rule ids counts (the judge may cite a neighbouring rule of the same element). */
  readonly anyOfRuleIds?: readonly string[];
  readonly sectionId: string;
  readonly severityFloor: string;
  readonly severityCeiling?: string;
  /** `deterministic`: found without a model; `llm`: needs the judge path. */
  readonly detect: "deterministic" | "llm";
  readonly major?: boolean;
  readonly para?: number;
}

export interface PolicyExpectation {
  readonly policyId: string;
  readonly kind: "clean" | "seeded";
  readonly sections: readonly SectionLabel[];
  readonly findings: readonly ExpectedFinding[];
  readonly forbidSeverities?: readonly string[];
  readonly maxMustFindings?: number;
  readonly maxShouldFindings?: number;
}

const ratio = (a: number, b: number): number => (b === 0 ? 1 : a / b);
const rank = (s: string): number => SEVERITY_RANK[s] ?? 0;

// --- segmentation ----------------------------------------------------------------------------------------------------

/** Share of labelled headings that the segmenter assigned to the labelled section id (matched by heading text). */
export function segmentationAccuracy(expected: readonly SectionLabel[], actual: readonly SectionLabel[]): { correct: number; total: number; accuracy: number; wrong: string[] } {
  const byTitle = new Map(actual.map((s) => [s.title, s.sectionId]));
  const wrong: string[] = [];
  let correct = 0;
  for (const e of expected) {
    const got = byTitle.get(e.title);
    if (got !== undefined && (got === e.sectionId || (e.alsoAccept ?? []).includes(got))) correct += 1;
    else wrong.push(`${e.title} -> ${byTitle.get(e.title) ?? "(missing)"}, expected ${e.sectionId}`);
  }
  return { correct, total: expected.length, accuracy: ratio(correct, expected.length), wrong };
}

export interface SpanPolicy {
  readonly text: string;
  readonly sections: readonly { readonly paras: readonly { readonly text: string; readonly span: { readonly start: number; readonly end: number } }[] }[];
}

/** Span fidelity: share of paragraphs whose span reproduces their text (design M8: 1.0). */
export function spanFidelity(policies: readonly SpanPolicy[]): { ok: number; total: number; fidelity: number } {
  let ok = 0;
  let total = 0;
  for (const p of policies) {
    for (const s of p.sections) {
      for (const para of s.paras) {
        total += 1;
        if (p.text.slice(para.span.start, para.span.end) === para.text) ok += 1;
      }
    }
  }
  return { ok, total, fidelity: ratio(ok, total) };
}

// --- Mode A: seeded defects and clean policies -----------------------------------------------------------------------

export function matchFinding(exp: ExpectedFinding, findings: readonly FindingLike[]): FindingLike | undefined {
  const ids = exp.anyOfRuleIds ?? (exp.ruleId ? [exp.ruleId] : []);
  return findings.find((f) => f.sectionId === exp.sectionId && (ids.length === 0 || ids.includes(f.ruleId)) && rank(f.severity) >= rank(exp.severityFloor) && (exp.severityCeiling === undefined || rank(f.severity) <= rank(exp.severityCeiling)));
}

export interface SeededScores {
  readonly total: number;
  readonly detected: number;
  readonly recall: number;
  readonly majorTotal: number;
  readonly majorDetected: number;
  readonly majorRecall: number;
  /** Expected findings that need the judge path and were not counted (deterministic run). */
  readonly skippedLlmOnly: number;
  readonly missed: readonly string[];
  readonly location: { readonly sectionCorrect: number; readonly sectionTotal: number; readonly paraCorrect: number; readonly paraTotal: number };
}

/** Seeded-defect recall over the expected findings of all policies. `llm: false` counts only deterministic ones. */
export function seededDefectScores(items: readonly { expected: PolicyExpectation; findings: readonly FindingLike[] }[], opts: { llm: boolean }): SeededScores {
  let total = 0;
  let detected = 0;
  let majorTotal = 0;
  let majorDetected = 0;
  let skipped = 0;
  let sectionTotal = 0;
  let sectionCorrect = 0;
  let paraTotal = 0;
  let paraCorrect = 0;
  const missed: string[] = [];
  for (const { expected, findings } of items) {
    for (const e of expected.findings) {
      if (e.detect === "llm" && !opts.llm) {
        skipped += 1;
        continue;
      }
      total += 1;
      if (e.major) majorTotal += 1;
      const hit = matchFinding(e, findings);
      if (!hit) {
        missed.push(`${expected.policyId}:${e.sectionId}:${e.ruleId ?? e.anyOfRuleIds?.join("|") ?? "*"}`);
        continue;
      }
      detected += 1;
      if (e.major) majorDetected += 1;
      sectionTotal += 1;
      if (hit.sectionId === e.sectionId) sectionCorrect += 1;
      if (e.para !== undefined) {
        paraTotal += 1;
        if (hit.location?.para === e.para) paraCorrect += 1;
      }
    }
  }
  return { total, detected, recall: ratio(detected, total), majorTotal, majorDetected, majorRecall: ratio(majorDetected, majorTotal), skippedLlmOnly: skipped, missed, location: { sectionCorrect, sectionTotal, paraCorrect, paraTotal } };
}

export interface CleanScores {
  readonly policies: number;
  /** Findings of severity critical or high (design M8: none allowed). */
  readonly criticalHigh: number;
  /** Findings above confirm level, worst policy (M8: at most 1 should-level). */
  readonly worstNonConfirm: number;
  readonly forbidden: number;
}

export function cleanPolicyScores(items: readonly { expected: PolicyExpectation; findings: readonly FindingLike[] }[]): CleanScores {
  let criticalHigh = 0;
  let worst = 0;
  let forbidden = 0;
  for (const { expected, findings } of items) {
    criticalHigh += findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
    worst = Math.max(worst, findings.filter((f) => f.severity !== "confirm").length);
    forbidden += findings.filter((f) => expected.forbidSeverities?.includes(f.severity)).length;
  }
  return { policies: items.length, criticalHigh, worstNonConfirm: worst, forbidden };
}

// --- Mode B: amendment impact ----------------------------------------------------------------------------------------

export interface ImpactScores {
  readonly recall: number;
  readonly precision: number;
  readonly mustRecall: number;
  readonly missed: readonly string[];
  /** Sections alerted that the label does not list. */
  readonly unaffectedAlerts: number;
}

/** `actual`: section ids of the Mode B findings of a policy. UNMAPPED never counts as a section. */
export function amendmentImpactScores(expected: readonly { sectionId: string; must?: boolean }[], actual: readonly string[]): ImpactScores {
  const got = new Set(actual.filter((s) => s !== "UNMAPPED"));
  const want = new Set(expected.map((e) => e.sectionId));
  const hit = [...want].filter((s) => got.has(s));
  const must = expected.filter((e) => e.must);
  const extra = [...got].filter((s) => !want.has(s));
  return {
    recall: ratio(hit.length, want.size),
    precision: ratio(got.size - extra.length, got.size),
    mustRecall: ratio(must.filter((e) => got.has(e.sectionId)).length, must.length),
    missed: [...want].filter((s) => !got.has(s)),
    unaffectedAlerts: extra.length,
  };
}

/** Decoy: the amendment must raise nothing on any policy. Counts every per-policy finding. */
export function decoyAlerts(perPolicy: readonly { policyId: string; findings: readonly { severity: string }[] }[]): { alerts: number; mustChange: number } {
  let alerts = 0;
  let must = 0;
  for (const p of perPolicy) {
    alerts += p.findings.length;
    must += p.findings.filter((f) => f.severity !== "confirm" && f.severity !== "low").length;
  }
  return { alerts, mustChange: must };
}

// --- Peer Watch ------------------------------------------------------------------------------------------------------

export interface ChangeEventLike {
  readonly cosmeticOnly: boolean;
  readonly changedSections: readonly { readonly sectionId: string; readonly quote?: string }[];
}

/** Cosmetic variants: `null` (no event) is fine; an event must be cosmeticOnly with no section record. */
export function cosmeticInvariance(events: readonly (ChangeEventLike | null)[]): { variants: number; alerts: number; sectionRecords: number } {
  let alerts = 0;
  let records = 0;
  for (const e of events) {
    if (!e) continue;
    records += e.changedSections.length;
    if (!e.cosmeticOnly) alerts += 1;
  }
  return { variants: events.length, alerts, sectionRecords: records };
}

export interface SubstantiveScores {
  /** Seeded edits detected (a non-cosmetic event). */
  readonly recall: number;
  /** Detected events that name exactly the edited section, over all non-cosmetic events. */
  readonly precision: number;
  /** Edits whose event names the edited section and nothing else. */
  readonly attribution: number;
  readonly wrong: readonly string[];
}

export function substantiveChangeScores(cases: readonly { name: string; expectedSections: readonly string[]; event: ChangeEventLike | null }[]): SubstantiveScores {
  let detected = 0;
  let exact = 0;
  let events = 0;
  const wrong: string[] = [];
  for (const c of cases) {
    const e = c.event && !c.event.cosmeticOnly ? c.event : null;
    if (e) {
      events += 1;
      detected += 1;
    }
    const ids = e ? e.changedSections.map((s) => s.sectionId).sort() : [];
    if (e && JSON.stringify(ids) === JSON.stringify([...c.expectedSections].sort())) exact += 1;
    else wrong.push(`${c.name}: expected ${c.expectedSections.join(",")}, got ${ids.join(",") || "(none)"}`);
  }
  return { recall: ratio(detected, cases.length), precision: ratio(exact, events), attribution: ratio(exact, cases.length), wrong };
}

// --- integrity -------------------------------------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const PHONE_RE = /(?<!\d)(?:01[016789][-. ]?\d{3,4}[-. ]?\d{4}|0\d{1,2}[-. ]\d{3,4}[-. ]\d{4})(?!\d)/;

export interface IntegrityResult {
  readonly reports: number;
  readonly missingDisclaimer: number;
  readonly piiHits: number;
  readonly overlongQuotes: number;
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Report texts must carry the disclaimer and no e-mail or phone pattern; quotes stay within `maxQuoteWords` (design C7: 25). */
export function reportIntegrity(texts: readonly string[], disclaimer: string, quotes: readonly string[] = [], maxQuoteWords = 25): IntegrityResult {
  return {
    reports: texts.length,
    missingDisclaimer: texts.filter((t) => !t.includes(disclaimer)).length,
    piiHits: texts.filter((t) => EMAIL_RE.test(t) || PHONE_RE.test(t)).length,
    overlongQuotes: quotes.filter((q) => wordCount(q) > maxQuoteWords).length,
  };
}

/** Jaccard similarity of two finding-key sets (design M8 stability: two runs >= 0.9). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 && y.size === 0) return 1;
  const inter = [...x].filter((k) => y.has(k)).length;
  return inter / (x.size + y.size - inter);
}

export const findingKey = (f: FindingLike): string => `${f.sectionId}|${f.ruleId}|${f.severity}`;

// --- gates -----------------------------------------------------------------------------------------------------------

export type GateStatus = "pass" | "fail" | "skip";

export interface GateRow {
  readonly id: string;
  readonly label: string;
  readonly threshold: string;
  readonly value: string;
  readonly status: GateStatus;
  readonly note?: string;
}

/** Measured values; `null` or absent = not measured (the gate is skipped with a note). */
export interface MonitorMetrics {
  readonly segmentationAccuracy: number | null;
  readonly spanFidelity: number | null;
  readonly realPolicySegmentation: number | null;
  readonly seeded: SeededScores | null;
  readonly clean: CleanScores | null;
  readonly unchangedHashAlerts: number | null;
  readonly amendmentB: ImpactScores | null;
  readonly decoyA: { alerts: number; mustChange: number } | null;
  readonly peerCosmetic: { variants: number; alerts: number; sectionRecords: number } | null;
  readonly peerSubstantive: SubstantiveScores | null;
  readonly integrity: IntegrityResult | null;
  readonly failClosed: { cases: number; failed: number } | null;
  readonly stability: number | null;
  readonly llm: boolean;
}

const f2 = (n: number): string => n.toFixed(2);
const pct = (n: number): string => n.toFixed(3);

function row(id: string, label: string, threshold: string, value: string | null, ok: boolean | null, note?: string): GateRow {
  if (value === null || ok === null) return { id, label, threshold, value: "n/a", status: "skip", ...(note ? { note } : {}) };
  return { id, label, threshold, value, status: ok ? "pass" : "fail", ...(note ? { note } : {}) };
}

export function evaluateMonitorGates(m: MonitorMetrics): GateRow[] {
  const rows: GateRow[] = [];
  const s = m.seeded;
  const c = m.clean;
  const b = m.amendmentB;
  const peerC = m.peerCosmetic;
  const peerS = m.peerSubstantive;
  const ig = m.integrity;
  rows.push(row("M8.seg", "Segmentation accuracy, golden drafts", ">= 0.95", m.segmentationAccuracy === null ? null : pct(m.segmentationAccuracy), m.segmentationAccuracy === null ? null : m.segmentationAccuracy >= 0.95));
  rows.push(row("M8.seg.real", "Segmentation accuracy, real policies", ">= 0.90", m.realPolicySegmentation === null ? null : pct(m.realPolicySegmentation), m.realPolicySegmentation === null ? null : m.realPolicySegmentation >= 0.9, m.realPolicySegmentation === null ? "real pages not present or changed (watch/lotte is gitignored; fetch with agent.ts peers --save-lotte)" : undefined));
  rows.push(row("M8.span", "Span fidelity", "= 1.0", m.spanFidelity === null ? null : pct(m.spanFidelity), m.spanFidelity === null ? null : m.spanFidelity === 1));
  rows.push(row("M8.recall", "Seeded-defect recall", ">= 0.90", s ? `${f2(s.recall)} (${s.detected}/${s.total})` : null, s ? s.recall >= 0.9 : null, s && s.skippedLlmOnly > 0 ? `${s.skippedLlmOnly} judge-only seed(s) not counted (run with --llm)` : s && s.missed.length > 0 ? `missed: ${s.missed.join(", ")}` : undefined));
  rows.push(row("M8.recall.major", "Seeded-defect recall, major", "= 1.0", s ? `${f2(s.majorRecall)} (${s.majorDetected}/${s.majorTotal})` : null, s ? s.majorRecall === 1 : null));
  rows.push(row("M8.loc.section", "Location: correct section", "= 1.0", s ? f2(ratio(s.location.sectionCorrect, s.location.sectionTotal)) : null, s ? s.location.sectionCorrect === s.location.sectionTotal : null));
  rows.push(row("M8.loc.para", "Location: correct paragraph", ">= 0.85", s && s.location.paraTotal > 0 ? f2(ratio(s.location.paraCorrect, s.location.paraTotal)) : null, s && s.location.paraTotal > 0 ? ratio(s.location.paraCorrect, s.location.paraTotal) >= 0.85 : null, s && s.location.paraTotal === 0 ? "no paragraph-labelled seed measured" : undefined));
  rows.push(row("M8.clean.crit", "Clean policies: critical/high false findings", "= 0", c ? String(c.criticalHigh) : null, c ? c.criticalHigh === 0 && c.forbidden === 0 : null));
  rows.push(row("M8.clean.should", "Clean policies: non-confirm findings per policy", "<= 1", c ? String(c.worstNonConfirm) : null, c ? c.worstNonConfirm <= 1 : null));
  rows.push(row("M8.hash", "Unchanged hash: alerts", "= 0", m.unchangedHashAlerts === null ? null : String(m.unchangedHashAlerts), m.unchangedHashAlerts === null ? null : m.unchangedHashAlerts === 0));
  rows.push(row("M8.amend.recall", "Amendment-impact recall (PIPA 21445)", ">= 0.90", b ? f2(b.recall) : null, b ? b.recall >= 0.9 : null, b && b.missed.length > 0 ? `missed: ${b.missed.join(", ")}` : undefined));
  rows.push(row("M8.amend.must", "Amendment-impact recall, must rules", "= 1.0", b ? f2(b.mustRecall) : null, b ? b.mustRecall === 1 : null));
  rows.push(row("M8.amend.prec", "Amendment-impact precision", ">= 0.80", b ? f2(b.precision) : null, b ? b.precision >= 0.8 : null));
  rows.push(row("M8.amend.unaffected", "Unaffected-section alerts", "= 0", b ? String(b.unaffectedAlerts) : null, b ? b.unaffectedAlerts === 0 : null));
  rows.push(row("C7.decoy", "Decoy amendment (Network Act 21988): alerts on policies", "= 0", m.decoyA ? `${m.decoyA.alerts} (must-change ${m.decoyA.mustChange})` : null, m.decoyA ? m.decoyA.alerts === 0 && m.decoyA.mustChange === 0 : null));
  rows.push(row("C7.cosmetic", "Peer cosmetic invariance: alerts + section records", "= 0", peerC ? `${peerC.alerts} + ${peerC.sectionRecords} (${peerC.variants} variants)` : null, peerC ? peerC.alerts === 0 && peerC.sectionRecords === 0 : null));
  rows.push(row("C7.subst.recall", "Peer substantive change recall", ">= 0.90", peerS ? f2(peerS.recall) : null, peerS ? peerS.recall >= 0.9 : null));
  rows.push(row("C7.subst.prec", "Peer substantive change precision", ">= 0.90", peerS ? f2(peerS.precision) : null, peerS ? peerS.precision >= 0.9 : null));
  rows.push(row("C7.attr", "Peer section attribution", ">= 0.90", peerS ? f2(peerS.attribution) : null, peerS ? peerS.attribution >= 0.9 : null, peerS && peerS.wrong.length > 0 ? peerS.wrong.join("; ") : undefined));
  rows.push(row("C7.integrity.disclaimer", "Reports: disclaimer present", "all", ig ? `${ig.reports - ig.missingDisclaimer}/${ig.reports}` : null, ig ? ig.missingDisclaimer === 0 && ig.reports > 0 : null));
  rows.push(row("C7.integrity.pii", "Reports: e-mail/phone patterns", "= 0", ig ? String(ig.piiHits) : null, ig ? ig.piiHits === 0 : null));
  rows.push(row("C7.integrity.quote", "Quotes over 25 words", "= 0", ig ? String(ig.overlongQuotes) : null, ig ? ig.overlongQuotes === 0 : null));
  rows.push(row("C7.failclosed", "Fail closed: unparseable/JS-only -> manual review", "all", m.failClosed ? `${m.failClosed.cases - m.failClosed.failed}/${m.failClosed.cases}` : null, m.failClosed ? m.failClosed.failed === 0 : null));
  rows.push(row("M8.stability", "Stability: finding-set Jaccard of two runs", ">= 0.90", m.stability === null ? null : f2(m.stability), m.stability === null ? null : m.stability >= 0.9, m.llm ? undefined : "deterministic run (a model run is the real test)"));
  return rows;
}

export function gatesFailed(rows: readonly GateRow[]): GateRow[] {
  return rows.filter((r) => r.status === "fail");
}

/** Fixed-width text table for the console. */
export function formatGateTable(rows: readonly GateRow[]): string {
  const w = (k: "id" | "label" | "threshold" | "value"): number => Math.max(k.length, ...rows.map((r) => [...r[k]].length));
  const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - [...s].length));
  const cols = { id: w("id"), label: w("label"), threshold: w("threshold"), value: w("value") };
  const line = (r: { id: string; label: string; threshold: string; value: string; status: string; note?: string | undefined }): string => `${pad(r.id, cols.id)}  ${pad(r.label, cols.label)}  ${pad(r.threshold, cols.threshold)}  ${pad(r.value, cols.value)}  ${r.status.toUpperCase()}${r.note ? `  (${r.note})` : ""}`;
  const out = [line({ id: "gate", label: "metric", threshold: "threshold", value: "value", status: "status" })];
  out.push("-".repeat(out[0]!.length));
  for (const r of rows) out.push(line(r));
  const failed = gatesFailed(rows).length;
  const skipped = rows.filter((r) => r.status === "skip").length;
  out.push("", `${rows.length - failed - skipped} pass, ${failed} fail, ${skipped} skipped`);
  return out.join("\n");
}

// --- peer page builder (synthetic pages from a Markdown policy) ------------------------------------------------------

export interface PeerPageOptions {
  readonly nav?: string;
  readonly footer?: string;
  readonly spacing?: "tight" | "loose";
  readonly markup?: "plain" | "wrapped";
  /** Add 1 to every heading number (an inserted section renumbers the rest). */
  readonly renumber?: boolean;
  /** Reverse the order of the numbered sections. */
  readonly reorder?: boolean;
  /** Plain string replacements applied to the Markdown before rendering (a seeded edit or a date change). */
  readonly edits?: readonly { readonly find: string; readonly replace: string }[];
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Renders the Markdown policy (`#`, `##`, bullets, tables, paragraphs) as a peer web page. Throws when an edit's `find` text is absent. */
export function peerPageHtml(markdown: string, o: PeerPageOptions = {}): string {
  let md = markdown;
  for (const e of o.edits ?? []) {
    if (!md.includes(e.find)) throw new Error(`peerPageHtml: edit text not found: ${e.find.slice(0, 30)}`);
    md = md.replace(e.find, e.replace);
  }
  const lines = md.split("\n");
  const head: string[] = [];
  const blocks: { heading: string; paras: string[] }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h2 = /^##\s+(.*)$/.exec(line);
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h2) {
      blocks.push({ heading: h2[1]!, paras: [] });
      continue;
    }
    if (h1) {
      head.push(`<h1>${esc(h1[1]!)}</h1>`);
      continue;
    }
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    const text = line.startsWith("|") ? line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join(" | ") : line.replace(/^-\s+/, "");
    (blocks.length === 0 ? head : blocks[blocks.length - 1]!.paras).push(blocks.length === 0 ? `<p>${esc(text)}</p>` : text);
  }
  const loose = o.spacing === "loose";
  const wrap = (p: string): string => (o.markup === "wrapped" ? `<div class="x"><span>${esc(p)}</span></div>` : `<p>${esc(p)}</p>`);
  const ordered = o.reorder ? [...blocks].reverse() : blocks;
  const body = ordered.map((b) => {
    const title = o.renumber ? b.heading.replace(/^(\d+)\./, (_m, n: string) => `${Number(n) + 1}.`) : b.heading;
    const h = loose ? `\n\n  <h2   class="h">  ${esc(title)}  </h2>\n` : `<h2>${esc(title)}</h2>`;
    return h + b.paras.map((p) => wrap(loose ? `  ${p.replace(/ /g, "  ")}\n` : p)).join(loose ? "\n\n" : "");
  });
  return `<html><head><title>x</title><style>.a{}</style></head><body><nav>${o.nav ?? "홈 | 고객센터 | 로그인"}</nav>${head.join("")}${body.join(loose ? "\n" : "")}<footer>${o.footer ?? "예시회사 고객센터 안내"}</footer></body></html>`;
}
