/**
 * Monitor and Peer Watch evaluation gates (confirmed design C3/C7, monitor design M8). Deterministic by default: no model call.
 *
 *   bun scripts/eval-gates.ts [--llm api|claude-code] [--out runs/eval] [--stamp <iso>]
 *
 * Inputs (all under golden/monitor): policies/<id>/{policy.md|policy.html, expected.json}, laws/*.json (parsed articles of two
 * law.go.kr versions), expected/*.json (hand labels, pending privacy-domain-expert review). Computes segmentation accuracy, seeded-defect
 * recall, clean-policy false findings, amendment-impact recall/precision (PIPA 제21445호) and the zero-alert decoy (정보통신망법
 * 제21988호), peer cosmetic invariance and seeded-edit detection (pages built from the golden clean policy), report integrity, fail-closed
 * and stability. Prints the gate table, writes runs/eval/eval-gates-<stamp>.json, exits 1 when a gate fails. Skipped gates (no real-policy
 * slice, judge-only seeds in a deterministic run) never fail and are named in the table.
 *
 * With `--llm` the Mode A judge and the Mode B judge run too: judge-only seeds then count, and stability compares two model runs.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UNMAPPED_SECTION, type IngestedPolicy } from "../packages/core/src/contracts/ingested-policy";
import { MONITOR_DISCLAIMER, type MonitorFinding, type MonitorReport } from "../packages/core/src/contracts/monitor-report";
import { EMPTY_REGISTRY } from "../packages/core/src/contracts/watch-registry";
import {
  amendmentImpactScores,
  cleanPolicyScores,
  cosmeticInvariance,
  decoyAlerts,
  evaluateMonitorGates,
  findingKey,
  formatGateTable,
  gatesFailed,
  jaccard,
  peerPageHtml,
  reportIntegrity,
  segmentationAccuracy,
  seededDefectScores,
  spanFidelity,
  substantiveChangeScores,
  type ChangeEventLike,
  type MonitorMetrics,
  type PolicyExpectation,
  type SectionLabel,
} from "../packages/core/src/eval/monitor-metrics";
import type { LlmClient } from "../packages/core/src/llm/client";
import { createBackendClient, resolveBackend } from "../packages/core/src/llm/factory";
import { krPaths, loadKrKnowledge } from "../packages/core/src/stages/coverage";
import { loadRuleSections } from "../packages/core/src/stages/draft/load-sections";
import { ingestPolicy, loadFinanceLexicon, loadHeadingPatterns } from "../packages/core/src/stages/ingest";
import { buildReport, checkCurrentPolicy, detectChange, diffArticles, loadLegalRefMap, numberFindings, recordCheck, renderMonitorJson, renderMonitorMarkdown, runImpact, type LawArticle } from "../packages/core/src/stages/monitor";
import { buildChangeEvent, normalizePolicyHtml, type NormalizedPolicy } from "../packages/core/src/stages/peers";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = join(import.meta.dir, "..");
const goldenDir = join(root, "golden", "monitor");
const stamp = (opt("stamp") ?? new Date().toISOString()).replace(/[:.]/g, "-");
const outDir = resolve(opt("out") ?? join(root, "runs", "eval"));
const NOW = new Date("2026-10-02T09:00:00.000Z");
const RUN_ID = "monitor-eval-001";

const backend = args.includes("--llm") ? resolveBackend(opt("llm")) : null;
if (args.includes("--llm") && !backend) {
  console.error("--llm needs api or claude-code");
  process.exit(2);
}
const backendClient = backend ? createBackendClient(backend) : null;
const llm: LlmClient | undefined = backendClient?.client;
console.log(backendClient ? `model backend: ${backend} (judge path on)` : "deterministic run: no model backend (judge-only seeds are skipped)");

// --- knowledge and labels ------------------------------------------------------------------------------------------

const krDir = join(root, "kb", "jurisdictions", "kr");
const kb = loadKrKnowledge(krPaths(root));
const ruleSections = loadRuleSections(join(krDir, "rulepacks"), ["privacy-2026.04"]);
const patterns = loadHeadingPatterns(root);
const lexicon = loadFinanceLexicon(root);
const legalRefMap = loadLegalRefMap(krDir);

interface GoldenPolicy {
  readonly dir: string;
  readonly file: string;
  readonly expected: PolicyExpectation;
}
const policiesDir = join(goldenDir, "policies");
const golden: GoldenPolicy[] = readdirSync(policiesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const file = readdirSync(join(policiesDir, d.name)).find((f) => /^policy\.(md|html)$/.test(f));
    if (!file) throw new Error(`golden/monitor/policies/${d.name}: no policy.md or policy.html`);
    return { dir: join(policiesDir, d.name), file, expected: JSON.parse(readFileSync(join(policiesDir, d.name, "expected.json"), "utf8")) as PolicyExpectation };
  })
  .sort((a, b) => a.expected.policyId.localeCompare(b.expected.policyId));

const ingest = (g: GoldenPolicy): IngestedPolicy => ingestPolicy({ name: `${g.expected.policyId}${g.file.endsWith(".html") ? ".html" : ".md"}`, content: readFileSync(join(g.dir, g.file)), fetchedAt: NOW, policyId: g.expected.policyId }, patterns, lexicon);
const ingested = new Map(golden.map((g) => [g.expected.policyId, ingest(g)]));

// --- Mode A --------------------------------------------------------------------------------------------------------

const detail: Record<string, unknown> = {};

async function modeA(): Promise<Map<string, MonitorReport>> {
  const out = new Map<string, MonitorReport>();
  for (const g of golden) {
    const policy = ingested.get(g.expected.policyId)!;
    const { report } = await checkCurrentPolicy({ ...(llm ? { llm } : {}) }, { runId: RUN_ID, policy, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now: NOW });
    out.set(g.expected.policyId, report);
  }
  return out;
}

const reportsA = await modeA();
const asItems = (kind: "clean" | "seeded") => golden.filter((g) => g.expected.kind === kind).map((g) => ({ expected: g.expected, findings: reportsA.get(g.expected.policyId)!.findings }));

const seg = golden.map((g) => segmentationAccuracy(g.expected.sections, ingested.get(g.expected.policyId)!.sections.map((s) => ({ title: s.title, sectionId: s.sectionId }))));
const segTotal = seg.reduce((n, s) => n + s.total, 0);
const segCorrect = seg.reduce((n, s) => n + s.correct, 0);
detail["segmentationWrong"] = seg.flatMap((s, i) => s.wrong.map((w) => `${golden[i]!.expected.policyId}: ${w}`));
const spans = spanFidelity([...ingested.values()]);

// Real-policy slice: labels are committed (golden/monitor/real), the pages are not (watch/ is gitignored). A page is scored only
// when its SHA-256 still equals the labelled one; otherwise the site changed and the labels may no longer fit.
const realSeg = (() => {
  const labelsFile = join(goldenDir, "real", "lotte-2026-10-02.json");
  const pagesDir = resolve(process.env["REAL_POLICY_DIR"] ?? join(root, "watch", "lotte"));
  if (!existsSync(labelsFile)) return null;
  const doc = JSON.parse(readFileSync(labelsFile, "utf8")) as { policies: { policyId: string; file: string; sourceSha256: string; textSha256?: string; sections: SectionLabel[] }[] };
  let correct = 0;
  let total = 0;
  const wrong: string[] = [];
  const skipped: string[] = [];
  for (const p of doc.policies) {
    const file = join(pagesDir, p.file);
    if (!existsSync(file)) {
      skipped.push(`${p.policyId}: page not present`);
      continue;
    }
    const bytes = readFileSync(file);
    const policy = ingestPolicy({ name: p.file, policyId: p.policyId, content: bytes.toString("utf8"), fetchedAt: NOW }, patterns, lexicon);
    // Raw bytes change with session tokens; the extracted policy text is what the labels describe.
    const same = p.textSha256 ? createHash("sha256").update(policy.text).digest("hex") === p.textSha256 : createHash("sha256").update(bytes).digest("hex") === p.sourceSha256;
    if (!same) {
      skipped.push(`${p.policyId}: policy text changed since labelling`);
      continue;
    }
    const r = segmentationAccuracy(p.sections, policy.sections.map((s) => ({ title: s.title, sectionId: s.sectionId })));
    correct += r.correct;
    total += r.total;
    wrong.push(...r.wrong.map((w) => `${p.policyId}: ${w}`));
  }
  detail["realSegmentationWrong"] = wrong;
  detail["realSegmentationSkipped"] = skipped;
  return total === 0 ? null : correct / total;
})();

// --- unchanged hash ------------------------------------------------------------------------------------------------

let registry = EMPTY_REGISTRY;
for (const p of ingested.values()) registry = recordCheck(registry, p, NOW);
const unchangedHashAlerts = golden.filter((g) => detectChange(registry, g.expected.policyId, ingest(g).source.sha256) !== "unchanged").length;

// --- Mode B --------------------------------------------------------------------------------------------------------

interface LawFixture {
  readonly law: string;
  readonly diffHash: string;
  readonly diffUnitCount: number;
  readonly old: { readonly articles: LawArticle[]; readonly effective: string | null; readonly promulgationNo: string };
  readonly new: { readonly articles: LawArticle[]; readonly effective: string | null; readonly promulgationNo: string };
}
const readJson = <T>(...p: string[]): T => JSON.parse(readFileSync(join(goldenDir, ...p), "utf8")) as T;

async function amendment(fixtureFile: string) {
  const fx = readJson<LawFixture>("laws", fixtureFile);
  const diff = diffArticles(fx.law, fx.old.articles, fx.new.articles, { oldVersion: fx.old.promulgationNo, newVersion: fx.new.promulgationNo, effectiveOn: fx.new.effective });
  const impact = await runImpact({ ...(llm ? { llm } : {}) }, { diff, policies: [...ingested.values()], ruleSections, legalRefMap, now: NOW });
  return { fx, diff, impact };
}

const pipa = await amendment("pipa-20897-to-21445.json");
const neta = await amendment("neta-21500-to-21988.json");
const labelPipa = readJson<{ expectedDiffUnitCount: number; expectedSections: { sectionId: string; rules: string[] }[]; mustRuleSections: string[]; mustIncludeSections: string[]; expectedUnmappedUnitCount: number }>("expected", "pipa-21445.json");
const labelNeta = readJson<{ expectedChangedKeys: string[] }>("expected", "neta-21988.json");

const fixtureIntegrity = {
  pipaDiffHashMatchesFixture: pipa.diff.hash === pipa.fx.diffHash,
  netaDiffHashMatchesFixture: neta.diff.hash === neta.fx.diffHash,
  pipaUnitCount: pipa.diff.units.length === labelPipa.expectedDiffUnitCount,
  pipaUnmappedCount: pipa.impact.unmapped.length === labelPipa.expectedUnmappedUnitCount,
  netaChangedKeys: JSON.stringify(neta.diff.units.map((u) => u.key)) === JSON.stringify(labelNeta.expectedChangedKeys),
  s18Present: labelPipa.mustIncludeSections.every((s) => labelPipa.expectedSections.some((e) => e.sectionId === s)),
};
detail["fixtureIntegrity"] = fixtureIntegrity;

// Impact is scored on the clean policy: every affected section is alerted whether or not the policy carries it (an absent section is a Confirm finding).
const impactOnClean = pipa.impact.perPolicy.get("clean") ?? [];
const amendmentB = amendmentImpactScores(
  labelPipa.expectedSections.map((e) => ({ sectionId: e.sectionId, must: labelPipa.mustRuleSections.includes(e.sectionId) })),
  impactOnClean.map((f) => f.sectionId),
);
const decoyA = decoyAlerts([...neta.impact.perPolicy].map(([policyId, findings]) => ({ policyId, findings })));
detail["decoyUnmappedListedOnce"] = neta.impact.unmapped.map((f) => f.trigger?.articleKey);

// --- Peer Watch ----------------------------------------------------------------------------------------------------

const cleanMd = readFileSync(join(policiesDir, "clean", "policy.md"), "utf8");
const normPage = (html: string): NormalizedPolicy => {
  const r = normalizePolicyHtml(html, patterns);
  if (r.unusable) throw new Error(`peer fixture page unusable: ${r.unusable}`);
  return r.policy;
};
const basePage = peerPageHtml(cleanMd);
const base = normPage(basePage);
const eventFor = (html: string, rawChanged = true): ChangeEventLike | null => buildChangeEvent({ peerId: "eval-peer", groupId: "eval", detectedAt: NOW, prev: base, next: normPage(html), rawChanged });

const cosmeticEvents: (ChangeEventLike | null)[] = [
  eventFor(peerPageHtml(cleanMd, { spacing: "loose" })),
  eventFor(peerPageHtml(cleanMd, { markup: "wrapped" })),
  eventFor(peerPageHtml(cleanMd, { nav: "홈 | 사이트맵 | 영문 | 이벤트 | 새 메뉴", footer: "다른 푸터 문구 고객센터 안내" })),
  eventFor(peerPageHtml(cleanMd, { renumber: true })),
  eventFor(peerPageHtml(cleanMd, { reorder: true })),
  eventFor(peerPageHtml(cleanMd, { edits: [{ find: "2026년 10월 1일부터", replace: "2026년 11월 15일부터" }] })),
  eventFor(basePage, false), // consecutive-day replay: the same page again
];

const EDITS: { name: string; section: string; edits: { find: string; replace: string }[] }[] = [
  { name: "S06 period", section: "S06", edits: [{ find: "지체 없이 파기합니다", replace: "5일 이내에 파기합니다" }] },
  { name: "S09 processor added", section: "S09", edits: [{ find: "| 예시클라우드 주식회사 | 전산 시스템 운영 |", replace: "| 예시클라우드 주식회사 | 전산 시스템 운영 |\n| 예시물류 주식회사 | 물류 운영 |" }] },
  { name: "S05 retention", section: "S05", edits: [{ find: "회원 탈퇴 시까지 보유합니다", replace: "회원 탈퇴 후 3년까지 보유합니다" }] },
  { name: "S11 measures", section: "S11", edits: [{ find: "암호화 등의 조치", replace: "암호화, 접속기록 점검 등의 조치" }] },
  { name: "S14 trackers", section: "S14", edits: [{ find: "쿠키를 사용합니다", replace: "쿠키와 행태정보 수집도구를 사용합니다" }] },
];
const substantive = substantiveChangeScores(EDITS.map((e) => ({ name: e.name, expectedSections: [e.section], event: eventFor(peerPageHtml(cleanMd, { edits: e.edits })) })));
const peerQuotes = EDITS.flatMap((e) => eventFor(peerPageHtml(cleanMd, { edits: e.edits }))?.changedSections.map((s) => s.quote ?? "") ?? []);

// --- report integrity (Mode A + Mode B reports, rendered as Markdown and JSON) -------------------------------------------

const titles = Object.fromEntries([...ruleSections].map(([id, s]) => [id, s.title.ko]));
const reportTexts: string[] = [];
const quotes: string[] = [];
const addReport = (r: MonitorReport): void => {
  reportTexts.push(renderMonitorMarkdown(r, { titles }), renderMonitorJson(r));
  for (const f of r.findings) quotes.push(f.location.quote);
};
for (const g of golden) {
  const policy = ingested.get(g.expected.policyId)!;
  const a = reportsA.get(g.expected.policyId)!;
  const modeB: MonitorFinding[] = pipa.impact.perPolicy.get(g.expected.policyId) ?? [];
  const merged = numberFindings("F", [...a.findings, ...modeB]).map((f, i) => ({ ...f, id: `${f.mode}-${String(i + 1).padStart(4, "0")}` }));
  addReport(buildReport({ runId: RUN_ID, policyId: g.expected.policyId, policySha: policy.source.sha256, rulePackVersion: kb.rulePackVersion, now: NOW, findings: merged, llmUsed: a.llmUsed || pipa.impact.llmUsed, warnings: a.warnings }));
}
const integrity = reportIntegrity(reportTexts, MONITOR_DISCLAIMER, [...quotes, ...peerQuotes]);

// --- fail closed ---------------------------------------------------------------------------------------------------

const JS_SHELL = `<html><head><title>개인정보 처리방침</title></head><body><div id="root"></div><script>window.__APP__=1;document.getElementById("root").innerHTML="loading";</script><noscript>JavaScript required</noscript></body></html>`;
const shells: { name: string; file: string; content: string | Uint8Array; peerToo: boolean }[] = [
  { name: "js-only html", file: "shell.html", content: JS_SHELL, peerToo: true },
  { name: "empty markdown", file: "empty.md", content: "", peerToo: false },
  { name: "pdf (not supported yet)", file: "scan.pdf", content: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"), peerToo: false },
  { name: "docx (not supported yet)", file: "policy.docx", content: Buffer.from("PK\u0003\u0004 not a readable document"), peerToo: false },
];
let failClosedFailed = 0;
const failClosedNotes: string[] = [];
for (const s of shells) {
  const p = ingestPolicy({ name: s.file, content: typeof s.content === "string" ? s.content : Buffer.from(s.content), fetchedAt: NOW }, patterns, lexicon);
  const { report } = await checkCurrentPolicy({}, { runId: RUN_ID, policy: p, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now: NOW });
  const reported = report.findings.length === 1 && report.findings[0]!.ruleId === "MON-INGEST" && report.findings[0]!.sectionId === UNMAPPED_SECTION && report.findings[0]!.severity === "confirm";
  const peerOk = s.peerToo ? normalizePolicyHtml(typeof s.content === "string" ? s.content : "", patterns).unusable !== null : true;
  if (p.status !== "needs_manual_review" || !reported || !peerOk) {
    failClosedFailed += 1;
    failClosedNotes.push(`${s.name}: status=${p.status} reported=${reported} peerUnusable=${peerOk}`);
  }
}
detail["failClosedFailures"] = failClosedNotes;

// --- stability: a second full run, finding sets compared -----------------------------------------------------------------

const keys = (reports: Map<string, MonitorReport>, impact: Map<string, MonitorFinding[]>): string[] => [
  ...[...reports].flatMap(([id, r]) => r.findings.map((f) => `${id}|${findingKey(f)}`)),
  ...[...impact].flatMap(([id, fs]) => fs.map((f) => `${id}|${findingKey(f)}`)),
];
const second = await modeA();
const secondImpact = (await amendment("pipa-20897-to-21445.json")).impact.perPolicy;
const stability = jaccard(keys(reportsA, pipa.impact.perPolicy), keys(second, secondImpact));

// --- gates ---------------------------------------------------------------------------------------------------------

const seeded = seededDefectScores(asItems("seeded"), { llm: backendClient !== null });
const clean = cleanPolicyScores(asItems("clean"));
const metrics: MonitorMetrics = {
  segmentationAccuracy: segTotal === 0 ? null : segCorrect / segTotal,
  spanFidelity: spans.total === 0 ? null : spans.fidelity,
  realPolicySegmentation: realSeg,
  seeded,
  clean,
  unchangedHashAlerts,
  amendmentB,
  decoyA,
  peerCosmetic: cosmeticInvariance(cosmeticEvents),
  peerSubstantive: substantive,
  integrity,
  failClosed: { cases: shells.length, failed: failClosedFailed },
  stability,
  llm: backendClient !== null,
};
const rows = evaluateMonitorGates(metrics);
// Fixture integrity is a gate of its own: labels that do not reproduce from the stored articles make every amendment number meaningless.
const fixtureOk = Object.values(fixtureIntegrity).every(Boolean);
rows.push({ id: "C7.fixtures", label: "Law fixtures reproduce their labels (diff hash, unit counts, S18 present)", threshold: "all", value: fixtureOk ? "ok" : JSON.stringify(fixtureIntegrity), status: fixtureOk ? "pass" : "fail" });

console.log(`\n${formatGateTable(rows)}\n`);
const failed = gatesFailed(rows);
if (failed.length > 0) console.log(`FAILED: ${failed.map((r) => r.id).join(", ")}`);
if (backendClient) {
  console.log("M1", backendClient.usageLine("M1") ?? "no calls");
  backendClient.close();
}

await mkdir(outDir, { recursive: true });
const file = join(outDir, `eval-gates-${stamp}.json`);
await writeFile(file, `${JSON.stringify({ stamp, mode: backendClient ? `llm:${backend}` : "deterministic", rulePack: kb.rulePackVersion, gates: rows, failed: failed.map((r) => r.id), metrics, detail: { ...detail, seededMissed: seeded.missed, peerWrong: substantive.wrong }, labelStatus: "amendment and policy labels pending privacy-domain-expert review" }, null, 2)}\n`);
console.log(`written: ${existsSync(file) ? file : "(failed)"}`);
process.exit(failed.length > 0 ? 1 : 0);
