import { describe, expect, test } from "bun:test";
import { AmendmentDiffSchema, AmendmentUnitSchema, IngestedPolicySchema, MONITOR_DISCLAIMER, MonitorFindingSchema, MonitorReportSchema, WatchRegistrySchema, summarizeFindings } from "../src/contracts";
import { ingestFixture } from "./monitor-fixtures";

const sha = "a".repeat(64);
const finding = (over: Record<string, unknown> = {}) => ({
  id: "A-0001",
  layer: "deterministic",
  ruleId: "C2-M-S06",
  sectionId: "S06",
  severity: "critical",
  message: "필수 항목 누락",
  fixHint: "추가",
  mode: "A",
  tier: "confirmed",
  location: { sectionId: "S06", para: null, quote: "" },
  ...over,
});
const report = (findings: unknown[], over: Record<string, unknown> = {}) => ({
  runId: "monitor-test-001",
  policyId: "acme-privacy",
  policySha: sha,
  rulePackVersion: "privacy-2026.04",
  checkedAt: "2026-10-02T09:00:00.000Z",
  findings,
  summary: summarizeFindings(findings as never),
  llmUsed: false,
  warnings: [],
  disclaimer: MONITOR_DISCLAIMER,
  ...over,
});

describe("IngestedPolicy", () => {
  test("a segmented fixture policy satisfies the contract", () => {
    const p = ingestFixture("policy-clean.md");
    expect(IngestedPolicySchema.safeParse(p).success).toBe(true);
  });

  test("a span that does not reproduce the paragraph text is rejected", () => {
    const p = structuredClone(ingestFixture("policy-clean.md"));
    p.sections[1]!.paras[0]!.span = { start: 0, end: 5 };
    expect(IngestedPolicySchema.safeParse(p).success).toBe(false);
  });

  test("unknown keys and bad ids are rejected (strict objects)", () => {
    const p = ingestFixture("policy-clean.md");
    expect(IngestedPolicySchema.safeParse({ ...p, extra: 1 }).success).toBe(false);
    expect(IngestedPolicySchema.safeParse({ ...p, policyId: "../etc" }).success).toBe(false);
    expect(IngestedPolicySchema.safeParse({ ...p, source: { ...p.source, sha256: "xyz" } }).success).toBe(false);
  });
});

describe("MonitorFinding and MonitorReport", () => {
  test("a valid Mode A finding and report parse", () => {
    expect(MonitorFindingSchema.safeParse(finding()).success).toBe(true);
    expect(MonitorReportSchema.safeParse(report([finding()])).success).toBe(true);
  });

  test("a provisional finding is capped at medium", () => {
    expect(MonitorFindingSchema.safeParse(finding({ tier: "provisional", severity: "high", mode: "B", trigger: { law: "PIPA", articleKey: "PIPA:30(1)1", effectiveOn: null } })).success).toBe(false);
    expect(MonitorFindingSchema.safeParse(finding({ tier: "provisional", severity: "medium", mode: "B", trigger: { law: "PIPA", articleKey: "PIPA:30(1)1", effectiveOn: "2026-12-01" } })).success).toBe(true);
  });

  test("Mode B needs a trigger; location must repeat the section id; severity scale includes confirm", () => {
    expect(MonitorFindingSchema.safeParse(finding({ mode: "B", tier: "provisional", severity: "medium" })).success).toBe(false);
    expect(MonitorFindingSchema.safeParse(finding({ location: { sectionId: "S05", para: 1, quote: "x" } })).success).toBe(false);
    expect(MonitorFindingSchema.safeParse(finding({ severity: "confirm" })).success).toBe(true);
    expect(MonitorFindingSchema.safeParse(finding({ severity: "blocker" })).success).toBe(false);
  });

  test("summary must match the findings; disclaimer is fixed; ids are unique", () => {
    expect(MonitorReportSchema.safeParse(report([finding()], { summary: summarizeFindings([]) })).success).toBe(false);
    expect(MonitorReportSchema.safeParse(report([finding()], { disclaimer: "다른 문구" })).success).toBe(false);
    expect(MonitorReportSchema.safeParse(report([finding(), finding()])).success).toBe(false);
  });
});

describe("AmendmentDiff", () => {
  test("units need the texts their change implies and a legal-ref key", () => {
    expect(AmendmentUnitSchema.safeParse({ key: "PIPA:38(1)", change: "amended", oldText: "a", newText: "b" }).success).toBe(true);
    expect(AmendmentUnitSchema.safeParse({ key: "PIPA:38(1)", change: "amended", oldText: "a" }).success).toBe(false);
    expect(AmendmentUnitSchema.safeParse({ key: "PIPA:38(1)", change: "added" }).success).toBe(false);
    expect(AmendmentUnitSchema.safeParse({ key: "PIPA:38(1)", change: "deleted", oldText: "a" }).success).toBe(true);
    expect(AmendmentUnitSchema.safeParse({ key: "not a key", change: "deleted", oldText: "a" }).success).toBe(false);
  });

  test("a diff carries law, versions, effective date and hash", () => {
    expect(AmendmentDiffSchema.safeParse({ law: "PIPA", oldVersion: "1", newVersion: "2", effectiveOn: null, units: [], hash: sha }).success).toBe(true);
    expect(AmendmentDiffSchema.safeParse({ law: "PIPA", oldVersion: "1", newVersion: "2", effectiveOn: "soon", units: [], hash: sha }).success).toBe(false);
  });
});

describe("WatchRegistry", () => {
  const entry = { policyId: "acme-privacy", source: { path: "watch/acme-privacy.md", format: "md" }, sha256: sha, firstSeenAt: "2026-10-02T09:00:00.000Z", lastCheckedAt: "2026-10-02T09:00:00.000Z" };
  test("entries are keyed by their policy id", () => {
    expect(WatchRegistrySchema.safeParse({ version: 1, updatedAt: null, policies: { "acme-privacy": entry } }).success).toBe(true);
    expect(WatchRegistrySchema.safeParse({ version: 1, updatedAt: null, policies: { other: entry } }).success).toBe(false);
    expect(WatchRegistrySchema.safeParse({ version: 2, updatedAt: null, policies: {} }).success).toBe(false);
  });
});
