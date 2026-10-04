import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./monitor-fixtures";
import { OrgConfigSchema } from "../src/contracts/org-config";
import { loadOrgConfig, orgConfigPath, tenantPaths } from "../src/config";
import { MockLlmClient } from "../src/llm";
import { DEFAULT_FRESHNESS_TARGETS, loadWatchTargets, loadWatchTargetsDetailed, runFreshnessDetailed, type LawApiPort, type PagePort } from "../src/stages/freshness";
import { loadLegalRefMap, parseLegalRefMap, prefixToSourceId, runImpact, sourceIdToPrefix, diffArticles, parseLawXml } from "../src/stages/monitor";
import { NOW, ingestFixture, readFixture, ruleSections } from "./monitor-fixtures";
import type { Manifest } from "../src/contracts/manifest";

const fx = (...p: string[]): string => join(import.meta.dir, "fixtures", "config", ...p);
const KR = join(ROOT, "kb", "jurisdictions", "kr");

describe("law watch targets as data", () => {
  test("the KB file has the same content as the built-in fallback list", () => {
    const file = JSON.parse(readFileSync(join(KR, "statutes", "law-targets.watch.json"), "utf8")) as { laws: unknown; pages: unknown };
    expect(file.laws).toEqual(DEFAULT_FRESHNESS_TARGETS.laws as never);
    expect(file.pages).toEqual(DEFAULT_FRESHNESS_TARGETS.pages as never);
  });

  test("a missing KB file falls back to targets.ts", () => {
    const r = loadWatchTargetsDetailed(fx("kr-empty"));
    expect(r.source).toBe("fallback");
    expect(r.targets).toEqual(DEFAULT_FRESHNESS_TARGETS);
  });

  test("additions are merged (manualReview allowed); duplicate sourceIds are ignored with a warning", () => {
    const r = loadWatchTargetsDetailed(fx("kr"));
    expect(r.source).toBe("file");
    expect(r.additionsLoaded).toBe(true);
    expect(r.targets.laws.map((l) => l.sourceId)).toEqual(["law:pipa", "law:artc", "law:cia"]);
    expect(r.targets.laws.find((l) => l.sourceId === "law:cia")?.monitorMode).toBe("manualReview");
    expect(r.targets.laws.find((l) => l.sourceId === "law:artc")?.name).toBe("약관의 규제에 관한 법률");
    expect(r.warnings.join(" ")).toContain("law:artc");
    expect(loadWatchTargets(fx("kr")).laws).toHaveLength(3);
  });

  test("the real KB loads, with or without the additions file", () => {
    expect(loadWatchTargets(KR).laws.length).toBeGreaterThanOrEqual(DEFAULT_FRESHNESS_TARGETS.laws.length);
  });
});

const manifest = (laws: Manifest["lawSnapshot"]["laws"]): Manifest => ({
  manifestVersion: "1.0.0",
  rulePacks: [],
  lawSnapshot: { id: "snap", laws },
  clauseLib: { version: "1.0.0", capturedAt: NOW.toISOString(), sites: [], vettedClauses: 0 },
  houseStyle: { version: "1.0.0" },
  pages: [],
});
const ver = (name: string, mst: string) => ({ target: "law" as const, name, lawId: `L${mst}`, mst, promulgatedOn: "2026-09-29", promulgationNo: "1", effectiveOn: "2026-10-30", revisionType: "일부개정", status: "현행" });

describe("manualReview targets in freshness", () => {
  test("a manualReview change has affectedSections [] and manualReview: true; a mapped one reaches sections", async () => {
    const lawApi: LawApiPort = { getCurrentVersion: async (name) => ver(name, name.startsWith("신용") ? "201" : "101"), listScheduledVersions: async () => [] };
    const pages: PagePort = { snapshot: async () => { throw new Error("no pages"); } };
    const targets = loadWatchTargets(fx("kr"));
    const m = manifest([
      { name: "개인정보 보호법", target: "law", id: "100", effective: "2026-01-01" },
      { name: "신용정보의 이용 및 보호에 관한 법률", target: "law", id: "200", effective: "2026-01-01" },
      { name: "약관의 규제에 관한 법률", target: "law", id: "300", effective: "2026-01-01" },
    ]);
    const ruleIndex = { lawCodes: { PIPA: "PIPA" }, lawIndex: { "PIPA:30(1)": ["S02"] }, sectionIds: ["S02"] };
    const r = await runFreshnessDetailed(m, { laws: targets.laws, pages: [] }, { lawApi, pages, ruleIndex, now: () => NOW });
    const cia = r.changes.find((c) => c.sourceId === "law:cia")!;
    expect(cia.kind).toBe("amendment_promulgated");
    expect(cia.manualReview).toBe(true);
    expect(cia.affectedSections).toEqual([]);
    expect([cia.oldMst, cia.newMst]).toEqual(["200", "201"]);
    const pipa = r.changes.find((c) => c.sourceId === "law:pipa")!;
    expect(pipa.manualReview).toBeUndefined();
    expect(r.report.affectedSections.map((s) => s.itemId)).toEqual(["S02"]);
    expect(r.report.affectedSections.every((s) => !s.sourceIds.includes("law:cia"))).toBe(true);
  });
});

describe("legal-ref map", () => {
  test("loads the record shape and the wrapped shape; absence is an empty map", () => {
    const map = loadLegalRefMap(fx("kr"));
    expect(Object.keys(map)).toEqual(["PIPA", "DEC", "CIA"]);
    expect(map["PIPA"]?.verifiedBy).toBe("fixture");
    expect(Object.keys(loadLegalRefMap(fx("kr-bare")))).toEqual(["EFTA"]);
    expect(loadLegalRefMap(fx("kr-empty"))).toEqual({});
  });

  test("invalid entries are an error", () => {
    expect(() => parseLegalRefMap({ pipa: { sourceId: "x" } })).toThrow("LEGALREF_MAP");
    expect(() => parseLegalRefMap({ PIPA: { sourceId: "law:pipa", lawNameKo: "x", kind: "act", aliases: [], monitorMode: "auto" } })).toThrow("LEGALREF_MAP");
    expect(() => parseLegalRefMap([])).toThrow("LEGALREF_MAP");
  });

  test("prefixToSourceId and the reverse lookup", () => {
    const map = loadLegalRefMap(fx("kr"));
    expect(prefixToSourceId(map, "CIA")).toBe("law:cia");
    expect(prefixToSourceId(map, "NOPE")).toBeNull();
    expect(sourceIdToPrefix(map, "law:pipa")).toBe("PIPA");
  });
});

describe("impact: manualReview prefixes", () => {
  const map = loadLegalRefMap(fx("kr"));
  const diff = diffArticles("CIA", parseLawXml(readFixture("law-old.xml")), parseLawXml(readFixture("law-new.xml")), { oldVersion: "200", newVersion: "201", effectiveOn: "2026-10-30" });
  const policies = [ingestFixture("policy-clean.md", "pol-one"), ingestFixture("policy-missing.md", "pol-two")];

  test("one Confirm finding per policy, labelled, no suggested wording, no LLM call", async () => {
    const llm = new MockLlmClient({ fixtures: {} });
    const r = await runImpact({ llm }, { diff, policies, ruleSections, legalRefMap: map, now: NOW });
    expect(llm.callCount()).toBe(0);
    expect(r.unmapped).toEqual([]);
    for (const id of ["pol-one", "pol-two"]) {
      const list = r.perPolicy.get(id)!;
      expect(list).toHaveLength(1);
      expect(list[0]!.severity).toBe("confirm");
      expect(list[0]!.message).toContain("금융 법령 해당 – 수동 검토");
      expect(list[0]!.fixHint).toBe("");
      expect(list[0]!.ruleId).toBe("MON-FINANCE-MANUAL");
    }
  });

  test("without the map the same units are mapped as before (no manual finding)", async () => {
    const r = await runImpact({}, { diff, policies, ruleSections, now: NOW });
    expect([...r.perPolicy.values()].flat().some((f) => f.ruleId === "MON-FINANCE-MANUAL")).toBe(false);
  });
});

describe("org config and tenant paths", () => {
  test("the example config loads and validates", () => {
    const org = loadOrgConfig(orgConfigPath(ROOT, "example"));
    expect(org.tenantId).toBe("example");
    expect(org.apps).toContain("check");
    expect(org.llm).toBe("none");
  });

  test("invalid configs are rejected", () => {
    const ok = loadOrgConfig(orgConfigPath(ROOT, "example"));
    expect(OrgConfigSchema.safeParse({ ...ok, tenantId: "../x" }).success).toBe(false);
    expect(OrgConfigSchema.safeParse({ ...ok, llm: "gpt" }).success).toBe(false);
    expect(OrgConfigSchema.safeParse({ ...ok, apps: [] }).success).toBe(false);
    expect(OrgConfigSchema.safeParse({ ...ok, rulePacks: [] }).success).toBe(false);
    expect(OrgConfigSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(() => loadOrgConfig(join(mkdtempSync(join(tmpdir(), "org-")), "org.json"))).toThrow("ORG_CONFIG");
  });

  test("every path is tenant-prefixed; the default tenant is 'default'", () => {
    const d = tenantPaths("/r/runs");
    expect(d.tenantId).toBe("default");
    expect(d.registryPath).toBe(join("/r/runs", "default", "monitor", "registry.json"));
    const t = tenantPaths("/r/runs", "acme");
    expect([t.monitorDir, t.dailyDir, t.freshnessDir, t.draftDir]).toEqual(["monitor", "daily", "freshness", "draft"].map((x) => join("/r/runs", "acme", x)));
    expect(() => tenantPaths("/r/runs", "../evil")).toThrow();
  });
});
