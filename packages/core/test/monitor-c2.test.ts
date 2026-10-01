import { describe, expect, test } from "bun:test";
import { PUBLISHED_SKIPPED_CHECKS, runC2 } from "../src/stages/check";
import { policyToAst } from "../src/stages/ingest";
import { MON_RUN_ID, ingestFixture, kb } from "./monitor-fixtures";

const placeholders = {
  ledger: { runId: MON_RUN_ID, jurisdiction: "kr" as const, slotRegistryVersion: "n/a", slots: {} },
  applicability: { runId: MON_RUN_ID, ruleSetVersions: [], documents: { privacy: { applicable: true }, terms: { applicable: false, reason: "n/a" } }, items: {}, warnings: [] },
  transcript: { runId: MON_RUN_ID, source: "text_file" as const, language: "ko", maskerVersion: "n/a", segments: [], placeholders: [] },
};
const published = (name: string) => {
  const { ast } = policyToAst(ingestFixture(name), { runId: MON_RUN_ID, effectiveDate: "2026-10-02", rulePackVersion: "privacy-2026.04" });
  return { ast, result: runC2({ runId: MON_RUN_ID, docType: "privacy", ast, rulePackItems: kb.rulePackItems, profile: "published", ...placeholders }) };
};

describe("C2 published profile", () => {
  test("runs only schema, empty sections, mandatory presence and recipient wording", () => {
    const { result } = published("policy-clean.md");
    expect(result.checks.map((c) => c.checkId)).toEqual(["structure.schema", "structure.empty_sections", "structure.mandatory_present", "safety.vague_recipients"]);
    expect(result.passed).toBe(true);
    for (const skipped of PUBLISHED_SKIPPED_CHECKS) expect(result.checks.some((c) => c.checkId === skipped)).toBe(false);
  });

  test("a clean published policy does not fail ledger- or citation-dependent checks even with empty placeholders", () => {
    // The same AST in the default (drafting) profile fails evidence-based checks or the applicability gate; the published profile ignores them.
    const { ast } = published("policy-clean.md");
    const drafting = runC2({ runId: MON_RUN_ID, docType: "privacy", ast, rulePackItems: kb.rulePackItems, ...placeholders });
    expect(drafting.checks.length).toBeGreaterThan(4);
    expect(drafting.checks.some((c) => c.checkId === "evidence.slot_refs")).toBe(true);
  });

  test("only mandatory sections are required; absent conditional sections are not flagged", () => {
    const { result } = published("policy-missing.md");
    const mandatory = result.checks.find((c) => c.checkId === "structure.mandatory_present")!;
    expect(mandatory.findings.map((f) => f.ruleId).sort()).toEqual(["C2-M-S06", "C2-M-S11"]);
    expect(result.checks.some((c) => c.checkId === "structure.conditional_handled")).toBe(false);
  });

  test("a heading with no body is an empty section", () => {
    const p = ingestFixture("policy-clean.md");
    const s03 = p.sections.find((s) => s.sectionId === "S03")!;
    const mutated = { ...p, sections: p.sections.map((s) => (s === s03 ? { ...s, paras: [] } : s)) };
    const { ast } = policyToAst(mutated, { runId: MON_RUN_ID, effectiveDate: "2026-10-02", rulePackVersion: "privacy-2026.04" });
    const r = runC2({ runId: MON_RUN_ID, docType: "privacy", ast, rulePackItems: kb.rulePackItems, profile: "published", ...placeholders });
    expect(r.checks.find((c) => c.checkId === "structure.empty_sections")!.findings.map((f) => f.sectionId)).toEqual(["S03"]);
  });

  test("an abbreviated recipient in the first table column is flagged", () => {
    const { result } = published("policy-vague.md");
    const vague = result.checks.find((c) => c.checkId === "safety.vague_recipients")!;
    expect(vague.passed).toBe(false);
    expect(vague.findings[0]!.ruleId).toBe("R-S07-003");
  });

  test("the default profile is unchanged: omitting `profile` runs every check", () => {
    const { ast } = published("policy-clean.md");
    const ids = runC2({ runId: MON_RUN_ID, docType: "privacy", ast, rulePackItems: kb.rulePackItems, ...placeholders }).checks.map((c) => c.checkId);
    for (const id of PUBLISHED_SKIPPED_CHECKS) if (id !== "cross_doc.values_equal" && id !== "style.emphasis") expect(ids).toContain(id);
  });
});
