import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MONITOR_DISCLAIMER } from "../src/contracts/monitor-report";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm";
import { buildReport, checkCurrentPolicy, detectChange, loadRegistry, recordCheck, renderMonitorJson, renderMonitorMarkdown, renderSummaryMarkdown, runImpact, safeText, saveRegistry } from "../src/stages/monitor";
import { diffArticles, parseLawXml } from "../src/stages/monitor";
import { MON_RUN_ID, NOW, ingestFixture, kb, patterns, readFixture, ruleSections } from "./monitor-fixtures";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pa-monitor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("registry", () => {
  const policy = ingestFixture("policy-clean.md", "acme-privacy");

  test("a missing file is an empty registry; save and load round-trip", async () => {
    const path = join(dir, "runs", "monitor", "registry.json");
    expect(loadRegistry(path).policies).toEqual({});
    const reg = recordCheck(loadRegistry(path), policy, NOW);
    await saveRegistry(path, reg);
    expect(loadRegistry(path)).toEqual(reg);
    expect(JSON.parse(await readFile(path, "utf8")).policies["acme-privacy"].sha256).toBe(policy.source.sha256);
  });

  test("sha256 change detection: new, unchanged, changed", () => {
    const reg = recordCheck(loadRegistry(join(dir, "none.json")), policy, NOW);
    expect(detectChange(reg, "acme-privacy", policy.source.sha256)).toBe("unchanged");
    expect(detectChange(reg, "acme-privacy", "b".repeat(64))).toBe("changed");
    expect(detectChange(reg, "other", policy.source.sha256)).toBe("new");
  });

  test("an unchanged hash lets the caller skip Mode A: the same file hashes the same, an edit does not", () => {
    const again = ingestFixture("policy-clean.md", "acme-privacy");
    const edited = ingestFixture("policy-vague.md", "acme-privacy");
    const reg = recordCheck(loadRegistry(join(dir, "none.json")), policy, NOW);
    expect(detectChange(reg, again.policyId, again.source.sha256)).toBe("unchanged");
    expect(detectChange(reg, edited.policyId, edited.source.sha256)).toBe("changed");
  });

  test("recordCheck keeps firstSeenAt and stores the last report pointer without any text", async () => {
    const { report } = await checkCurrentPolicy({}, { runId: MON_RUN_ID, policy, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now: NOW });
    const first = recordCheck(loadRegistry(join(dir, "none.json")), policy, NOW, { report, file: "stamp/acme-privacy.md" });
    const later = recordCheck(first, policy, new Date("2026-10-03T09:00:00.000Z"));
    const e = later.policies["acme-privacy"]!;
    expect([e.firstSeenAt, e.lastCheckedAt]).toEqual(["2026-10-02T09:00:00.000Z", "2026-10-03T09:00:00.000Z"]);
    expect(e.lastReport?.file).toBe("stamp/acme-privacy.md");
    expect(JSON.stringify(later)).not.toContain("회사는");
  });

  test("a corrupt registry is an error, not a silent reset", async () => {
    const path = join(dir, "registry.json");
    await writeFile(path, "{not json");
    expect(() => loadRegistry(path)).toThrow("MONITOR_REGISTRY");
    await writeFile(path, JSON.stringify({ version: 1, updatedAt: null, policies: { x: {} } }));
    expect(() => loadRegistry(path)).toThrow("MONITOR_REGISTRY");
  });
});

describe("reports", () => {
  const phone = /\b0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}\b/;
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

  async function fullReport() {
    const policy = ingestFixture("policy-vague.md", "acme-privacy");
    const llm = new MockLlmClient({ fixtures: { M1: (r: StructuredCallRequest) => (r.schemaName === "MonitorImpactJudge" ? { verdict: "must_change", quote: "", suggestedWording: "연락처 010-0000-0000 또는 privacy@example.com 으로 안내" } : { findings: [] }) } });
    const a = await checkCurrentPolicy({ llm }, { runId: MON_RUN_ID, policy, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now: NOW });
    const diff = diffArticles("PIPA", parseLawXml(readFixture("law-old.xml")), parseLawXml(readFixture("law-new.xml")), { effectiveOn: "2026-12-01" });
    const b = await runImpact({ llm }, { diff, policies: [policy], ruleSections, now: NOW });
    const findings = [...a.report.findings, ...b.perPolicy.get("acme-privacy")!].map((f, i) => ({ ...f, id: `${f.mode}-${String(i + 1).padStart(4, "0")}` }));
    return { report: buildReport({ runId: MON_RUN_ID, policyId: "acme-privacy", policySha: policy.source.sha256, rulePackVersion: kb.rulePackVersion, now: NOW, findings, llmUsed: true, warnings: [] }), unmapped: b.unmapped };
  }

  test("Markdown report: disclaimer, severity table, location, quote, fix direction, provisional tier label", async () => {
    const { report } = await fullReport();
    const md = renderMonitorMarkdown(report, { titles: { S02: "개인정보의 처리 목적" } });
    expect(md).toContain(MONITOR_DISCLAIMER);
    expect(md.split(MONITOR_DISCLAIMER).length - 1).toBe(2); // top and bottom
    expect(md).toContain("| 중간 (Medium) |");
    expect(md).toContain("미검증 – 도메인 검토 대기");
    expect(md).toContain("검증됨 (규칙 팩 기준)");
    expect(md).toContain("- 위치: S07 제2문단");
    expect(md).toContain("수정 방향:");
    expect(md).toContain("개정 조문: PIPA PIPA:2\\[2\\] (시행 2026-12-01)");
  });

  test("no e-mail address or phone number appears in the Markdown, JSON or summary", async () => {
    const { report, unmapped } = await fullReport();
    const md = renderMonitorMarkdown(report);
    const json = renderMonitorJson(report);
    const summary = renderSummaryMarkdown({ stamp: "2026-10-02T09-00-00-000Z", entries: [{ policyId: "acme-privacy", status: "checked", report }], unmapped });
    for (const text of [md, json, summary]) {
      expect(text).not.toMatch(email);
      expect(text).not.toMatch(phone);
    }
    expect(JSON.parse(json).disclaimer).toBe(MONITOR_DISCLAIMER);
    expect(summary).toContain("규칙과 연결되지 않은 개정 조문");
  });

  test("safeText masks contacts a model might echo and defuses Markdown, HTML and mentions", () => {
    const t = safeText("연락 privacy@example.com 010-0000-0000 [click](http://x) <b>x</b> @everyone `code`\n줄바꿈");
    expect(t).not.toMatch(email);
    expect(t).not.toMatch(phone);
    expect(t).not.toContain("<b>");
    expect(t).not.toMatch(/(?<!\\)\]\(/);
    expect(t).not.toContain("@everyone");
    expect(t).not.toContain("\n");
  });

  test("an empty report does not read as a pass", async () => {
    const policy = ingestFixture("policy-clean.md", "acme-privacy");
    const { report } = await checkCurrentPolicy({}, { runId: MON_RUN_ID, policy, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now: NOW });
    const md = renderMonitorMarkdown(report);
    expect(md).toContain("적합하다는 뜻이 아니며");
    expect(md).toContain("결정적 검사만");
  });
});
