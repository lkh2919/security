import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { stampsFromManifest, type Manifest } from "../src/contracts/manifest";
import { MockLlmClient } from "../src/llm";
import { RunStore, runResumableStage } from "../src/pipeline";
import { runDaily, type DailyDeps } from "../src/stages/daily";
import type { LawApiPort } from "../src/stages/freshness";
import { loadRegistry } from "../src/stages/monitor";
import { NOW, ingestFixture, kb, patterns, readFixture, ruleSections } from "./monitor-fixtures";
import { toUsageRecord } from "../src/llm";

const KR = join(import.meta.dir, "fixtures", "config", "kr");
const manifest: Manifest = {
  manifestVersion: "1.0.0",
  rulePacks: [],
  lawSnapshot: {
    id: "snap",
    laws: [
      { name: "개인정보 보호법", target: "law", id: "100", effective: "2026-01-01" },
      { name: "신용정보의 이용 및 보호에 관한 법률", target: "law", id: "200", effective: "2026-01-01" },
      { name: "약관의 규제에 관한 법률", target: "law", id: "300", effective: "2026-01-01" },
    ],
  },
  clauseLib: { version: "1.0.0", capturedAt: NOW.toISOString(), sites: [], vettedClauses: 0 },
  houseStyle: { version: "1.0.0" },
  pages: [],
};
const ver = (name: string, mst: string, eff: string) => ({ target: "law" as const, name, lawId: `L${mst}`, mst, promulgatedOn: "2026-09-29", promulgationNo: "1", effectiveOn: eff, revisionType: "일부개정", status: "현행" });

function setup(opts: { failTextOnce?: boolean } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "daily-"));
  const counts = { current: 0, text: 0, textFailed: false };
  const lawApi: LawApiPort = {
    getCurrentVersion: async (name) => {
      counts.current++;
      if (name.startsWith("신용")) return ver(name, "201", "2026-10-30");
      if (name === "개인정보 보호법") return ver(name, "101", "2026-10-30");
      return { ...ver(name, "300", "2026-01-01"), promulgatedOn: "2025-01-01" };
    },
    listScheduledVersions: async () => [],
  };
  const lawText = {
    getFullTextXml: async (mst: string): Promise<string> => {
      counts.text++;
      if (opts.failTextOnce && !counts.textFailed) {
        counts.textFailed = true;
        throw new Error("simulated network failure");
      }
      return readFixture(mst === "100" || mst === "200" ? "law-old.xml" : "law-new.xml");
    },
  };
  const llm = new MockLlmClient({ fixtures: {} });
  const deps: DailyDeps = {
    krDir: KR,
    tenantId: "acme",
    runsRoot: join(tmp, "runs", "acme", "daily"),
    registryPath: join(tmp, "runs", "acme", "monitor", "registry.json"),
    apps: { check: true, impact: true },
    loadPolicies: () => [ingestFixture("policy-clean.md", "pol-one"), ingestFixture("policy-missing.md", "pol-two")],
    ruleSections,
    rulePackItems: kb.rulePackItems,
    rulePackVersion: kb.rulePackVersion,
    patterns,
    lawApi,
    lawText,
    manifest,
    now: () => NOW,
    usage: { usageRecords: () => [toUsageRecord({ stageId: "M1", modelId: "claude-opus-5-5", usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })] },
  };
  void llm;
  return { tmp, counts, deps };
}

describe("daily chain", () => {
  test("freshness -> Mode B -> Mode A -> digest, finance as manual review, tenant-prefixed outputs", async () => {
    const { deps, counts } = setup();
    const r = await runDaily(deps);
    expect(r.steps.map((s) => [s.stage, s.resumed])).toEqual([["daily-freshness", false], ["daily-impact", false], ["daily-recheck", false], ["daily-digest", false]]);
    expect(r.runId).toBe("daily-20261002");
    expect(r.dir).toContain(join("runs", "acme", "daily"));
    expect(counts.current).toBe(3);
    expect(counts.text).toBe(4); // PIPA old+new, CIA old+new (ARTC unchanged)
    const digest = readFileSync(r.digestFile, "utf8");
    expect(digest).toContain("금융 법령 해당");
    expect(digest).toContain("모델 사용량");
    expect(digest).toContain("PIPA");
    const reportJson = JSON.parse(readFileSync(join(r.dir, "reports", "pol-one.json"), "utf8")) as { findings: { ruleId: string; fixHint: string }[] };
    expect(reportJson.findings.some((f) => f.ruleId === "MON-FINANCE-MANUAL" && f.fixHint === "")).toBe(true);
    expect(existsSync(join(r.dir, "usage.jsonl"))).toBe(true);
    expect(Object.keys(loadRegistry(deps.registryPath).policies).sort()).toEqual(["pol-one", "pol-two"]);
  });

  test("a step that fails once resumes on rerun: finished steps are not repeated", async () => {
    const { deps, counts } = setup({ failTextOnce: true });
    await expect(runDaily(deps)).rejects.toThrow("simulated network failure");
    const store = await RunStore.open(deps.runsRoot, "daily-20261002");
    const state = await store.readState();
    expect(state.stages["daily-freshness"]?.status).toBe("done");
    expect(state.stages["daily-impact"]?.status).toBe("failed");
    expect(state.stages["daily-recheck"]).toBeUndefined();
    expect(counts.current).toBe(3);

    const r = await runDaily(deps);
    expect(r.steps.map((s) => [s.stage, s.resumed])).toEqual([["daily-freshness", true], ["daily-impact", false], ["daily-recheck", false], ["daily-digest", false]]);
    expect(counts.current).toBe(3); // freshness was not repeated
    expect(existsSync(r.digestFile)).toBe(true);
    expect((await store.readState()).stages["daily-impact"]?.status).toBe("done");

    const again = await runDaily(deps);
    expect(again.steps.every((s) => s.resumed)).toBe(true);
    expect(counts.text).toBe(1 + 4); // one failed attempt, then the full set once
  });

  test("without a law API the freshness step is skipped with a note and the rest still runs", async () => {
    const { deps } = setup();
    const { lawApi: _a, lawText: _t, ...rest } = deps;
    void _a;
    void _t;
    const r = await runDaily(rest);
    const digest = readFileSync(r.digestFile, "utf8");
    expect(digest).toContain("LAW\\_GO\\_KR\\_OC");
    expect(digest).toContain("pol-one");
  });

  test("a disabled app's step is skipped", async () => {
    const { deps } = setup();
    const r = await runDaily({ ...deps, apps: { check: false, impact: false } });
    expect(readFileSync(r.digestFile, "utf8")).toContain("건너뜀");
    expect(Object.keys(loadRegistry(deps.registryPath).policies)).toEqual(["pol-one", "pol-two"]);
  });
});

describe("runResumableStage", () => {
  test("reuses a done artifact, reruns a failed stage", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "rs-"));
    const store = await RunStore.create({ runsRoot: tmp, runId: "resume-test-1", input: {}, stamps: stampsFromManifest(manifest, { interviewTemplateVersion: "1", slotRegistryVersion: "1", prompts: {} }), documents: ["privacy"] });
    const schema = z.strictObject({ n: z.number() });
    let calls = 0;
    const compute = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { n: calls };
    };
    await expect(runResumableStage(store, { stage: "daily-digest", schema, compute })).rejects.toThrow("boom");
    expect((await store.readState()).stages["daily-digest"]?.status).toBe("failed");
    const ok = await runResumableStage(store, { stage: "daily-digest", schema, compute });
    expect([ok.output.n, ok.resumed]).toEqual([2, false]);
    const again = await runResumableStage(store, { stage: "daily-digest", schema, compute });
    expect([again.output.n, again.resumed, calls]).toEqual([2, true, 2]);
  });
});
