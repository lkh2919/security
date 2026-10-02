import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MONITOR_DISCLAIMER } from "../src/contracts/monitor-report";
import {
  amendmentImpactScores,
  cleanPolicyScores,
  cosmeticInvariance,
  decoyAlerts,
  evaluateMonitorGates,
  formatGateTable,
  gatesFailed,
  jaccard,
  matchFinding,
  peerPageHtml,
  reportIntegrity,
  segmentationAccuracy,
  seededDefectScores,
  spanFidelity,
  substantiveChangeScores,
  type FindingLike,
  type MonitorMetrics,
  type PolicyExpectation,
} from "../src/eval/monitor-metrics";
import { diffArticles, runImpact, type LawArticle } from "../src/stages/monitor";
import { ingestPolicy } from "../src/stages/ingest";
import { buildChangeEvent, normalizePolicyHtml } from "../src/stages/peers";
import { NOW, ROOT, patterns, ruleSections } from "./monitor-fixtures";

const cases = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "monitor-eval", "cases.json"), "utf8")) as {
  seededExpectation: PolicyExpectation;
  findingsAllFound: FindingLike[];
  findingsDowngraded: FindingLike[];
  cleanExpectation: PolicyExpectation;
};
const GOLDEN = join(ROOT, "golden", "monitor");
const goldenJson = <T>(...p: string[]): T => JSON.parse(readFileSync(join(GOLDEN, ...p), "utf8")) as T;

describe("segmentation and spans", () => {
  const expected = [{ title: "a", sectionId: "S02" }, { title: "b", sectionId: "S06" }, { title: "c", sectionId: "S09" }, { title: "d", sectionId: "S11" }];
  test("accuracy counts headings with the labelled id; a missing heading is wrong", () => {
    const r = segmentationAccuracy(expected, [{ title: "a", sectionId: "S02" }, { title: "b", sectionId: "S07" }, { title: "c", sectionId: "S09" }]);
    expect(r.correct).toBe(2);
    expect(r.accuracy).toBe(0.5);
    expect(r.wrong).toHaveLength(2);
    expect(segmentationAccuracy([], []).accuracy).toBe(1);
  });
  test("span fidelity finds a span that does not reproduce its paragraph", () => {
    const ok = { text: "abc\ndef", sections: [{ paras: [{ text: "abc", span: { start: 0, end: 3 } }, { text: "def", span: { start: 4, end: 7 } }] }] };
    const bad = { text: "abc\ndef", sections: [{ paras: [{ text: "abc", span: { start: 0, end: 3 } }, { text: "def", span: { start: 3, end: 6 } }] }] };
    expect(spanFidelity([ok]).fidelity).toBe(1);
    expect(spanFidelity([ok, bad])).toMatchObject({ ok: 3, total: 4 });
  });
});

describe("Mode A scores", () => {
  const items = (findings: FindingLike[]) => [{ expected: cases.seededExpectation, findings }];

  test("all seeds found: recall 1, major recall 1, section and paragraph location correct", () => {
    const s = seededDefectScores(items(cases.findingsAllFound), { llm: true });
    expect(s).toMatchObject({ total: 3, detected: 3, recall: 1, majorRecall: 1, skippedLlmOnly: 0 });
    expect(s.location).toEqual({ sectionCorrect: 3, sectionTotal: 3, paraCorrect: 1, paraTotal: 1 });
  });

  test("a deterministic run skips judge-only seeds instead of counting them as misses", () => {
    const s = seededDefectScores(items(cases.findingsAllFound.slice(0, 2)), { llm: false });
    expect(s).toMatchObject({ total: 2, detected: 2, recall: 1, skippedLlmOnly: 1 });
    expect(seededDefectScores(items(cases.findingsAllFound.slice(0, 2)), { llm: true })).toMatchObject({ total: 3, detected: 2 });
  });

  test("a finding below the severity floor does not count; a wrong paragraph lowers the paragraph score", () => {
    const s = seededDefectScores(items(cases.findingsDowngraded), { llm: false });
    expect(s.detected).toBe(1);
    expect(s.majorRecall).toBe(0);
    expect(s.missed).toEqual(["seed-a:S06:C2-M-S06"]);
    expect(s.location.paraCorrect).toBe(0);
  });

  test("floor, ceiling and anyOf rule ids", () => {
    const f: FindingLike = { ruleId: "R-S18-003", sectionId: "S18", severity: "confirm" };
    expect(matchFinding({ anyOfRuleIds: ["R-S18-001", "R-S18-003"], sectionId: "S18", severityFloor: "confirm", severityCeiling: "confirm", detect: "llm" }, [f])).toBe(f);
    expect(matchFinding({ ruleId: "R-S18-003", sectionId: "S18", severityFloor: "low", detect: "llm" }, [f])).toBeUndefined();
    expect(matchFinding({ ruleId: "R-S18-003", sectionId: "S19", severityFloor: "confirm", detect: "llm" }, [f])).toBeUndefined();
    expect(matchFinding({ sectionId: "S18", severityFloor: "high", severityCeiling: "medium", detect: "llm" }, [{ ...f, severity: "medium" }])).toBeUndefined(); // empty range matches nothing
  });

  test("clean policies: critical/high and forbidden severities are counted, the worst policy sets the non-confirm count", () => {
    const e = cases.cleanExpectation;
    expect(cleanPolicyScores([{ expected: e, findings: [] }])).toMatchObject({ criticalHigh: 0, worstNonConfirm: 0, forbidden: 0 });
    const s = cleanPolicyScores([
      { expected: e, findings: [{ ruleId: "x", sectionId: "S01", severity: "high" }, { ruleId: "y", sectionId: "S01", severity: "low" }, { ruleId: "z", sectionId: "S01", severity: "confirm" }] },
      { expected: e, findings: [{ ruleId: "x", sectionId: "S01", severity: "medium" }] },
    ]);
    expect(s).toMatchObject({ policies: 2, criticalHigh: 1, worstNonConfirm: 2, forbidden: 1 });
  });
});

describe("Mode B scores", () => {
  const expected = [{ sectionId: "S09", must: true }, { sectionId: "S18", must: true }, { sectionId: "S19", must: false }, { sectionId: "S13", must: false }];
  test("recall, must recall, precision and unaffected-section alerts", () => {
    const perfect = amendmentImpactScores(expected, ["S09", "S18", "S19", "S13", "UNMAPPED"]);
    expect(perfect).toMatchObject({ recall: 1, precision: 1, mustRecall: 1, unaffectedAlerts: 0 });
    const r = amendmentImpactScores(expected, ["S18", "S19", "S05", "S06"]);
    expect(r.recall).toBe(0.5);
    expect(r.mustRecall).toBe(0.5);
    expect(r.precision).toBe(0.5);
    expect(r.unaffectedAlerts).toBe(2);
    expect(r.missed).toEqual(["S09", "S13"]);
  });
  test("decoy: any per-policy finding is an alert; firm severities count as must-change", () => {
    expect(decoyAlerts([{ policyId: "a", findings: [] }, { policyId: "b", findings: [] }])).toEqual({ alerts: 0, mustChange: 0 });
    expect(decoyAlerts([{ policyId: "a", findings: [{ severity: "confirm" }, { severity: "medium" }] }])).toEqual({ alerts: 2, mustChange: 1 });
  });
});

describe("Peer Watch scores", () => {
  const cosmetic = { cosmeticOnly: true, changedSections: [] };
  test("cosmetic invariance: no event and a cosmetic-only event pass; a section record or a substantive event does not", () => {
    expect(cosmeticInvariance([null, cosmetic])).toEqual({ variants: 2, alerts: 0, sectionRecords: 0 });
    expect(cosmeticInvariance([null, { cosmeticOnly: false, changedSections: [{ sectionId: "S06" }] }, { cosmeticOnly: true, changedSections: [{ sectionId: "S02" }] }])).toEqual({ variants: 3, alerts: 1, sectionRecords: 2 });
  });
  test("substantive scores: recall, precision and attribution separate a missed edit, a wrong section and an extra section", () => {
    const ev = (...ids: string[]) => ({ cosmeticOnly: false, changedSections: ids.map((sectionId) => ({ sectionId })) });
    const s = substantiveChangeScores([
      { name: "ok", expectedSections: ["S06"], event: ev("S06") },
      { name: "missed", expectedSections: ["S09"], event: cosmetic },
      { name: "wrong", expectedSections: ["S05"], event: ev("S11") },
      { name: "extra", expectedSections: ["S14"], event: ev("S14", "S16") },
    ]);
    expect(s.recall).toBe(0.75);
    expect(s.precision).toBeCloseTo(1 / 3);
    expect(s.attribution).toBe(0.25);
    expect(s.wrong).toHaveLength(3);
  });
});

describe("integrity, stability and gates", () => {
  const ok = `# 보고서\n\n> ${MONITOR_DISCLAIMER}\n\n전화번호: [전화번호] 이메일: [이메일]\n`;
  test("disclaimer, e-mail, phone and quote length", () => {
    expect(reportIntegrity([ok], MONITOR_DISCLAIMER)).toEqual({ reports: 1, missingDisclaimer: 0, piiHits: 0, overlongQuotes: 0 });
    const bad = reportIntegrity(["본문 a.b@corp.example 끝", "010-1234-5678 ", "02-123-4567", `x ${MONITOR_DISCLAIMER}`], MONITOR_DISCLAIMER, ["a ".repeat(26), "a b c"]);
    expect(bad).toEqual({ reports: 4, missingDisclaimer: 3, piiHits: 3, overlongQuotes: 1 });
    expect(reportIntegrity(["1234-5678 건 2026-10-02 ".concat(MONITOR_DISCLAIMER)], MONITOR_DISCLAIMER).piiHits).toBe(0);
  });
  test("jaccard", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard(["a", "a"], ["a"])).toBe(1);
  });

  const good: MonitorMetrics = {
    segmentationAccuracy: 1,
    spanFidelity: 1,
    realPolicySegmentation: null,
    seeded: { total: 10, detected: 10, recall: 1, majorTotal: 4, majorDetected: 4, majorRecall: 1, skippedLlmOnly: 0, missed: [], location: { sectionCorrect: 10, sectionTotal: 10, paraCorrect: 2, paraTotal: 2 } },
    clean: { policies: 1, criticalHigh: 0, worstNonConfirm: 0, forbidden: 0 },
    unchangedHashAlerts: 0,
    amendmentB: { recall: 1, precision: 1, mustRecall: 1, missed: [], unaffectedAlerts: 0 },
    decoyA: { alerts: 0, mustChange: 0 },
    peerCosmetic: { variants: 7, alerts: 0, sectionRecords: 0 },
    peerSubstantive: { recall: 1, precision: 1, attribution: 1, wrong: [] },
    integrity: { reports: 4, missingDisclaimer: 0, piiHits: 0, overlongQuotes: 0 },
    failClosed: { cases: 3, failed: 0 },
    stability: 1,
    llm: false,
  };
  test("all measured gates pass with the design thresholds; the real-policy slice is skipped, not failed", () => {
    const rows = evaluateMonitorGates(good);
    expect(gatesFailed(rows)).toEqual([]);
    expect(rows.filter((r) => r.status === "skip").map((r) => r.id)).toEqual(["M8.seg.real"]);
    expect(formatGateTable(rows)).toContain("pass, 0 fail, 1 skipped");
  });
  test("each threshold fails on its own", () => {
    const fail = (patch: Partial<MonitorMetrics>): string[] => gatesFailed(evaluateMonitorGates({ ...good, ...patch })).map((r) => r.id);
    expect(fail({ segmentationAccuracy: 0.94 })).toEqual(["M8.seg"]);
    expect(fail({ spanFidelity: 0.99 })).toEqual(["M8.span"]);
    expect(fail({ realPolicySegmentation: 0.89 })).toEqual(["M8.seg.real"]);
    expect(fail({ seeded: { ...good.seeded!, recall: 0.89, majorRecall: 1 } })).toEqual(["M8.recall"]);
    expect(fail({ seeded: { ...good.seeded!, majorRecall: 0.75 } })).toEqual(["M8.recall.major"]);
    expect(fail({ clean: { ...good.clean!, criticalHigh: 1 } })).toEqual(["M8.clean.crit"]);
    expect(fail({ clean: { ...good.clean!, worstNonConfirm: 2 } })).toEqual(["M8.clean.should"]);
    expect(fail({ unchangedHashAlerts: 1 })).toEqual(["M8.hash"]);
    expect(fail({ amendmentB: { ...good.amendmentB!, recall: 0.8 } })).toEqual(["M8.amend.recall"]);
    expect(fail({ amendmentB: { ...good.amendmentB!, mustRecall: 0.5 } })).toEqual(["M8.amend.must"]);
    expect(fail({ amendmentB: { ...good.amendmentB!, precision: 0.79 } })).toEqual(["M8.amend.prec"]);
    expect(fail({ amendmentB: { ...good.amendmentB!, unaffectedAlerts: 1 } })).toEqual(["M8.amend.unaffected"]);
    expect(fail({ decoyA: { alerts: 1, mustChange: 0 } })).toEqual(["C7.decoy"]);
    expect(fail({ peerCosmetic: { variants: 7, alerts: 0, sectionRecords: 1 } })).toEqual(["C7.cosmetic"]);
    expect(fail({ peerSubstantive: { recall: 0.8, precision: 1, attribution: 1, wrong: [] } })).toEqual(["C7.subst.recall"]);
    expect(fail({ peerSubstantive: { recall: 1, precision: 0.89, attribution: 1, wrong: [] } })).toEqual(["C7.subst.prec"]);
    expect(fail({ peerSubstantive: { recall: 1, precision: 1, attribution: 0.5, wrong: ["x"] } })).toEqual(["C7.attr"]);
    expect(fail({ integrity: { reports: 4, missingDisclaimer: 1, piiHits: 0, overlongQuotes: 0 } })).toEqual(["C7.integrity.disclaimer"]);
    expect(fail({ integrity: { reports: 4, missingDisclaimer: 0, piiHits: 1, overlongQuotes: 0 } })).toEqual(["C7.integrity.pii"]);
    expect(fail({ integrity: { reports: 4, missingDisclaimer: 0, piiHits: 0, overlongQuotes: 1 } })).toEqual(["C7.integrity.quote"]);
    expect(fail({ failClosed: { cases: 3, failed: 1 } })).toEqual(["C7.failclosed"]);
    expect(fail({ stability: 0.85 })).toEqual(["M8.stability"]);
  });
  test("unmeasured inputs skip their gates", () => {
    const rows = evaluateMonitorGates({ ...good, seeded: null, amendmentB: null, peerCosmetic: null });
    expect(rows.filter((r) => r.status === "skip").map((r) => r.id)).toContain("M8.recall");
    expect(gatesFailed(rows)).toEqual([]);
  });
});

describe("peer page builder", () => {
  const md = readFileSync(join(GOLDEN, "policies", "clean", "policy.md"), "utf8");
  const norm = (html: string) => {
    const r = normalizePolicyHtml(html, patterns);
    expect(r.unusable).toBeNull();
    return r.policy;
  };
  test("renders headings, table rows and list items and normalizes to the policy's sections", () => {
    const base = norm(peerPageHtml(md));
    const ids = base.sections.map((x) => x.sectionId);
    for (const id of ["S02", "S03", "S05", "S06", "S09", "S11", "S18", "S24"]) expect(ids).toContain(id);
    expect(base.text).toContain("예시클라우드 주식회사 | 전산 시스템 운영");
  });
  test("cosmetic variants share the baseline hash; a seeded edit changes only its section", () => {
    const base = norm(peerPageHtml(md));
    for (const o of [{ spacing: "loose" as const }, { markup: "wrapped" as const }, { renumber: true }, { reorder: true }, { nav: "다른 메뉴", footer: "다른 푸터" }]) {
      expect(norm(peerPageHtml(md, o)).contentSha256).toBe(base.contentSha256);
    }
    const next = norm(peerPageHtml(md, { edits: [{ find: "지체 없이 파기합니다", replace: "5일 이내에 파기합니다" }] }));
    const ev = buildChangeEvent({ peerId: "peer-1", groupId: "retail", detectedAt: NOW, prev: base, next })!;
    expect(ev.changedSections.map((s) => s.sectionId)).toEqual(["S06"]);
    expect(() => peerPageHtml(md, { edits: [{ find: "없는 문구", replace: "x" }] })).toThrow("edit text not found");
  });
});

describe("golden/monitor labels", () => {
  interface Fx {
    law: string;
    diffHash: string;
    diffUnitCount: number;
    old: { articles: LawArticle[]; effective: string | null };
    new: { articles: LawArticle[]; effective: string | null };
  }
  const diffOf = (fx: Fx) => diffArticles(fx.law, fx.old.articles, fx.new.articles, { effectiveOn: fx.new.effective });

  test("PIPA 제21445호: the stored articles reproduce the diff, and the label is its intersection with the rule packs (Art. 31 -> S18)", async () => {
    const fx = goldenJson<Fx>("laws", "pipa-20897-to-21445.json");
    const label = goldenJson<{ expectedSections: { sectionId: string; units: string[] }[]; expectedDiffUnitCount: number; expectedUnmappedUnitCount: number; mustIncludeSections: string[] }>("expected", "pipa-21445.json");
    const diff = diffOf(fx);
    expect(diff.hash).toBe(fx.diffHash);
    expect(diff.units).toHaveLength(label.expectedDiffUnitCount);
    const impact = await runImpact({}, { diff, policies: [], ruleSections, now: NOW });
    expect(impact.unmapped).toHaveLength(label.expectedUnmappedUnitCount);
    expect(label.expectedSections.map((s) => s.sectionId)).toContain("S18");
    expect(label.mustIncludeSections).toEqual(["S18"]);
    expect(label.expectedSections.find((s) => s.sectionId === "S18")!.units.every((u) => u.startsWith("PIPA:31("))).toBe(true);
  });

  test("Network Act 제21988호: exactly the two terminology changes, no rule cites them, no policy gets a finding", async () => {
    const fx = goldenJson<Fx>("laws", "neta-21500-to-21988.json");
    const label = goldenJson<{ expectedClass: string; expectedChangedKeys: string[]; expectedFindings: unknown[] }>("expected", "neta-21988.json");
    const diff = diffOf(fx);
    expect(diff.hash).toBe(fx.diffHash);
    expect(diff.units.map((u) => u.key)).toEqual(["NETA:44-7(4)1", "NETA:49-3(1)"]);
    expect(label).toMatchObject({ expectedClass: "no_policy_impact", expectedFindings: [] });
    const policy = ingestPolicy({ name: "p.md", content: readFileSync(join(GOLDEN, "policies", "clean", "policy.md")), fetchedAt: NOW }, patterns);
    const impact = await runImpact({}, { diff, policies: [policy], ruleSections, now: NOW });
    expect(impact.perPolicy.get(policy.policyId)).toEqual([]);
    expect(impact.unmapped.map((f) => f.trigger?.articleKey)).toEqual(label.expectedChangedKeys);
  });

  test("every policy label names real rule-pack sections and carries the review status", () => {
    const dirs = ["clean", "missing", "vague", "unlabelled", "html", "seed-s18-no-contact", "seed-s09-etc", "seed-s06-deleted"];
    for (const d of dirs) {
      const e = goldenJson<PolicyExpectation & { labelStatus: string }>("policies", d, "expected.json");
      expect(e.policyId).toBe(d);
      expect(e.labelStatus).toContain("pending privacy-domain-expert review");
      for (const s of e.sections) expect(ruleSections.has(s.sectionId), `${d} ${s.sectionId}`).toBe(true);
      for (const f of e.findings) expect(ruleSections.has(f.sectionId), `${d} ${f.sectionId}`).toBe(true);
    }
  });
});

describe("eval-gates script", () => {
  test("deterministic run exits 0, prints the gate table and writes the JSON record", async () => {
    const out = mkdtempSync(join(tmpdir(), "eval-gates-"));
    const p = Bun.spawn(["bun", join(ROOT, "scripts", "eval-gates.ts"), "--out", out, "--stamp", "unit-test"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(text).toContain("M8.amend.recall");
    expect(text).toContain("0 fail");
    const rec = JSON.parse(readFileSync(join(out, "eval-gates-unit-test.json"), "utf8")) as { failed: string[]; mode: string };
    expect(rec).toMatchObject({ failed: [], mode: "deterministic" });
  }, 120_000);
});
