import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { articleOfUnit, assembleDashboard, DISCLAIMER, jsonForScript, loadMonitorReports, maskDeep, NO_IMPACT_LABEL, PEER_LABEL, renderDashboardHtml } from "../../../apps/dashboard/assemble";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CONFIG = join(ROOT, "config", "orgs", "example", "org.json");

function fakeReport(policyId: string, checkedAt: string, findings: object[]) {
  return { runId: "monitor-x", policyId, policySha: "a".repeat(64), rulePackVersion: "privacy-2026.04", checkedAt, findings, summary: {}, llmUsed: true, warnings: [], disclaimer: DISCLAIMER };
}

describe("dashboard data assembly", () => {
  test("unit keys map to articles", () => {
    expect(articleOfUnit("PIPA:31(4)1")).toEqual({ law: "PIPA", article: "31" });
    expect(articleOfUnit("PIPA:31-2(1)1")).toEqual({ law: "PIPA", article: "31-2" });
    expect(articleOfUnit("nonsense")).toBeNull();
  });

  test("masks contacts in every string and escapes script-breaking characters", () => {
    const m = maskDeep({ a: ["문의 kim.cs@corp.co.kr 또는 010-1234-5678"] });
    expect(JSON.stringify(m)).not.toMatch(/kim\.cs|1234-5678/);
    expect(jsonForScript({ x: "</script><b>" })).not.toContain("</script");
  });

  test("keeps the latest report per policy and builds Mode A and Mode B views", () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(dir, "s1"));
    mkdirSync(join(dir, "s2"));
    const a = { id: "A-1", mode: "A", severity: "high", tier: "confirmed", ruleId: "R-S18-001", sectionId: "S18", message: "m", fixHint: "고치세요 privacy.officer@corp.co.kr", location: { sectionId: "S18", para: 1, quote: "q" } };
    const c = { id: "A-2", mode: "A", severity: "confirm", tier: "confirmed", ruleId: "MON-CONFIRM", sectionId: "S02", message: "m", questions: ["Q1", "Q2"], location: { sectionId: "S02", para: null, quote: "" } };
    const b = { id: "B-1", mode: "B", severity: "medium", tier: "provisional", ruleId: "R-S18-001", sectionId: "S18", message: "개정", fixHint: "추가", trigger: { law: "PIPA", articleKey: "PIPA:31(1)", effectiveOn: "2026-09-11" }, location: { sectionId: "S18", para: 2, quote: "책임자" } };
    writeFileSync(join(dir, "s1", "p.json"), JSON.stringify(fakeReport("p", "2026-10-01T00:00:00.000Z", [])));
    writeFileSync(join(dir, "s2", "p.json"), JSON.stringify(fakeReport("p", "2026-10-02T00:00:00.000Z", [a, c, b])));
    writeFileSync(join(dir, "s2", "registry.json"), "{}");
    expect(loadMonitorReports(dir).reports.length).toBe(1);

    const d = assembleDashboard({ root: ROOT, configPath: CONFIG, monitorDir: dir, now: new Date("2026-10-02T00:00:00Z") });
    expect(d.policies).toHaveLength(1);
    expect(d.policies[0].bySeverity).toMatchObject({ high: 1, confirm: 1 });
    expect(d.policies[0].confirmSections[0].questions).toEqual(["Q1", "Q2"]);
    expect(JSON.stringify(d)).not.toContain("privacy.officer@corp");
    const pipa = d.amendments.find((x: any) => x.law === "PIPA");
    expect(pipa.policyFindings).toHaveLength(1);
    expect(pipa.tier).toBe("미검증(도메인 검토 대기)");
    expect(d.overview.bySeverity.confirm).toBe(1);
  });

  test("amendments from golden fixtures: PIPA affects sections, Network Act decoy has no impact", () => {
    const d = assembleDashboard({ root: ROOT, configPath: CONFIG, monitorDir: join(tmpdir(), "no-such-dir-dashboard") });
    const pipa = d.amendments.find((x: any) => x.law === "PIPA");
    const neta = d.amendments.find((x: any) => x.law === "NETA");
    expect(pipa.sections.map((s: any) => s.sectionId)).toEqual(["S09", "S11", "S13", "S18", "S19"]);
    expect(pipa.articles.find((x: any) => x.article === "31").sectionIds).toContain("S18");
    expect(neta.noImpact).toBe(true);
    expect(neta.noImpactLabel).toBe(NO_IMPACT_LABEL);
    expect(neta.sections).toHaveLength(0);
    expect(neta.policyFindings).toHaveLength(0);
  });

  test("peers: fixed label, aggregates first, no ranking or per-company score fields", () => {
    const d = assembleDashboard({ root: ROOT, configPath: CONFIG });
    if (!d.peers) return; // runs/ is gitignored: absent on a fresh clone
    expect(d.peers.label).toBe(PEER_LABEL);
    expect(d.peers.totals.active).toBeGreaterThan(0);
    const keys = JSON.stringify(d.peers);
    expect(keys).not.toMatch(/"(rank|score|rating)"/i);
    for (const g of d.peers.groups) for (const p of g.peers) expect(Object.keys(p).sort()).toEqual(["changedSectionIds", "name", "status"]);
  });

  test("renders one self-contained HTML file without external references", () => {
    const d = assembleDashboard({ root: ROOT, configPath: CONFIG, monitorDir: join(tmpdir(), "no-such-dir-dashboard") });
    const html = renderDashboardHtml(join(ROOT, "apps", "dashboard"), d);
    expect(html).toContain('id="dashboard-data"');
    expect(html).not.toMatch(/(src|href)=["']https?:/i);
    expect(html).not.toContain("__DATA__");
    expect(html).not.toContain("/*__CSS__*/");
    const json = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/)![1]!;
    expect(JSON.parse(json).meta.disclaimer).toBe(DISCLAIMER);
    expect(readFileSync(join(ROOT, "apps", "dashboard", "app.js"), "utf8")).not.toMatch(/fetch\(|XMLHttpRequest/);
  });
});
