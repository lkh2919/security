import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocAST } from "../src/contracts/ast";
import type { Finding } from "../src/contracts/audit-report";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../src/contracts/fact-ledger";
import { HouseStyleFileSchema } from "../src/contracts/house-style";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm/client";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { citationsFromRulePacks, runC2, type LexiconEntry } from "../src/stages/check";
import { draftDocument, loadRuleSections, type SectionDraft } from "../src/stages/draft";
import { loadClauseLibrary, runMatch, type ClauseLibrary } from "../src/stages/match";
import { maskedTranscript } from "./fixtures";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KR = join(ROOT, "kb", "jurisdictions", "kr");
const RUN_ID = "20260930-120000-0a1b2c";
const kb = loadKrKnowledge(krPaths(ROOT));
const library = loadClauseLibrary(KR, kb.registry);
const ruleSections = loadRuleSections(join(KR, "rulepacks"));
const citations = citationsFromRulePacks(join(KR, "rulepacks"));
const houseStyle = HouseStyleFileSchema.parse(JSON.parse(readFileSync(join(KR, "house-style", "lotte-innovate.candidates.json"), "utf8")));
const lexicon = (JSON.parse(readFileSync(join(KR, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json"), "utf8")) as { entries: LexiconEntry[] }).entries;

function golden(id: string, extra: Record<string, unknown> = {}) {
  const expected = JSON.parse(readFileSync(join(ROOT, "golden", "cases", id, "expected.json"), "utf8")) as { slots: Record<string, unknown> };
  const slots: Record<string, SlotEntry> = {};
  for (const [k, v] of Object.entries({ ...expected.slots, ...extra })) {
    slots[k] = v === "needs_manual_review" ? { status: "needs_manual_review", value: null, confidence: 0, evidence: [] } : { status: "filled", value: v as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: "golden", quote: "" }] };
  }
  const ledger: FactLedger = createFactLedgerSchema(kb.registry).parse({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots });
  const { applicability } = runCoverage({ runId: RUN_ID, ledger, template: kb.template, rulePackItems: kb.rulePackItems, termsItems: kb.termsItems, rulePackVersion: kb.rulePackVersion, termsPackAvailable: true });
  return { ledger, applicability };
}

/** Mock drafter: one paragraph per section, citing nothing, using the first fact as slotRef. */
const draftFixture = (req: StructuredCallRequest): SectionDraft => {
  const body = req.user.slice(req.user.indexOf("\n") + 1, req.user.lastIndexOf("\n"));
  const p = JSON.parse(body) as { section: { id: string; title: string }; facts: Record<string, unknown>; fixFindings: unknown[] };
  const slot = Object.keys(p.facts)[0];
  return { status: "drafted", missingFacts: [], blocks: [{ t: "para", runs: [{ t: "text", text: `${p.section.title} 초안${p.fixFindings.length ? " (수정됨)" : ""}입니다.`, ...(slot ? { slotRef: slot } : {}) }] }] };
};

async function run(docType: "privacy" | "terms", id: string, lib: ClauseLibrary = library, llm = new MockLlmClient({ fixtures: { R5P: draftFixture, R5T: draftFixture } }), extra: Record<string, unknown> = {}) {
  const { ledger, applicability } = golden(id, extra);
  const { selection } = await runMatch({ runId: RUN_ID, ledger, applicability, library: lib, houseStyle });
  const result = await draftDocument({ llm }, { docType, runId: RUN_ID, effectiveDate: "2026-10-01", lawSnapshotId: "law-2026-09-29", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library: lib, ruleSections, houseStyle, citations });
  return { ...result, ledger, applicability, selection, llm };
}
const c2 = (ast: DocAST, ledger: FactLedger, applicability: ReturnType<typeof golden>["applicability"]) =>
  runC2({ runId: RUN_ID, docType: ast.docType, ast, ledger, applicability, rulePackItems: kb.rulePackItems, transcript: { ...maskedTranscript, runId: RUN_ID }, citations, houseStyle, lexicon });
const status = (ast: DocAST, id: string) => ast.sections.find((s) => s.id === id)?.status;

describe("draftDocument (privacy, G1)", () => {
  test("every applicable section is drafted; known-no items become not-processed statements; C2 passes", async () => {
    const r = await run("privacy", "G1");
    expect(status(r.ast, "S09")).toBe("drafted");
    expect(status(r.ast, "S07")).toBe("not_processed_statement");
    expect(status(r.ast, "S10")).toBe("not_processed_statement");
    expect(r.ast.sections.find((s) => s.id === "S04")).toBeUndefined(); // gate false: omitted
    const ids = r.ast.sections.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    expect(r.ast.meta.models.R5P).toContain("sonnet");
    const check = c2(r.ast, r.ledger, r.applicability);
    expect(check.checks.filter((c) => !c.passed).map((c) => `${c.checkId}: ${c.findings[0]?.message}`)).toEqual([]);
  });

  test("the committed library has no vetted clause, so every drafted section uses the LLM; nothing else does", async () => {
    const r = await run("privacy", "G1");
    expect(r.clauseSections).toEqual([]);
    expect(r.llm.callCount("R5P")).toBe(r.llmSections.length);
    expect(r.llmSections).toContain("S09");
    expect(r.llm.calls.every((c) => c.modelId.includes("sonnet"))).toBe(true);
  });

  test("the LLM payload carries facts, rules and allowed citations but never the transcript or vault", async () => {
    const r = await run("privacy", "G1");
    const s09 = r.llm.calls.find((c) => c.user.includes('"id":"S09"'))!;
    expect(s09.user).toContain("한빛택배");
    expect(s09.user).toContain("R-S09-001");
    expect(s09.user).not.toContain("인터뷰어"); // no transcript text
    expect(s09.user).not.toContain("quote");
    expect(s09.system).not.toMatch(/rubric|auditor/i);
  });

  test("S20 gets the remedy bodies from the KB (verified status included); other sections do not", async () => {
    const r = await run("privacy", "G2");
    const s20 = r.llm.calls.find((c) => c.user.includes('"id":"S20"'));
    expect(s20).toBeDefined();
    expect(s20!.user).toContain('"remedyAgencies"');
    expect(s20!.user).toContain("공소청");
    expect(s20!.user).not.toContain("대검찰청");
    expect(s20!.user).toContain('"status":"pending"');
    expect(r.llm.calls.filter((c) => !c.user.includes('"id":"S20"')).every((c) => !c.user.includes('"remedyAgencies"'))).toBe(true);
  });

  test("a vetted clause with full coverage renders in code with no LLM call", async () => {
    const vetted: ClauseLibrary = {
      version: "0.1.0",
      skipped: [],
      clauses: [
        {
          domainGroup: "cross_group",
          frequencyRatio: 1,
          record: { clauseId: "lotte.privacy.S06.cross_group.99", docType: "privacy", itemIds: ["S06"], body: "개인정보는 보유기간이 끝나면 지체 없이 파기합니다.", vars: [], conditions: [], provenance: { sourceUrl: "https://example.com/p", affiliate: "a", businessGroup: "cross_group", captureDate: "2026-09-29", contentHash: "a".repeat(64) }, vetted: true, vettedAgainst: "privacy-2026.04", styleRefs: [] },
        },
      ],
    };
    const r = await run("privacy", "G1", vetted);
    expect(r.clauseSections).toEqual(["S06"]);
    expect(r.llmSections).not.toContain("S06");
    const s06 = r.ast.sections.find((s) => s.id === "S06")!;
    expect(s06.trace.clauseRefs).toEqual(["lotte.privacy.S06.cross_group.99"]);
    expect(r.llm.calls.some((c) => c.user.includes('"id":"S06"'))).toBe(false);
  });

  test("delegation vs provision ambiguity (G2b): S07 and S09 draft candidate rows for the unclear party and stay manual_review", async () => {
    const r = await run("privacy", "G2b");
    expect(status(r.ast, "S07")).toBe("manual_review");
    expect(status(r.ast, "S09")).toBe("manual_review");
    for (const id of ["S07", "S09"]) {
      const call = r.llm.calls.find((c) => c.user.includes(`"section":{"id":"${id}"`))!;
      expect(call.user).toContain('"ambiguousParties":[{"party":"페이온"');
    }
    expect(r.missingFacts.filter((m) => m.text.includes("페이온")).map((m) => m.sectionId).sort()).toEqual(["S07", "S09"]);
  });

  test("an unknown gate without a role assessment stays a manual-review note with no LLM call", async () => {
    const r = await run("privacy", "G2b", library, undefined, { "privacy.S09_roleAssessment": "needs_manual_review" });
    expect(status(r.ast, "S09")).toBe("manual_review");
    expect(r.llm.calls.some((c) => c.user.includes('"section":{"id":"S09"'))).toBe(false);
  });

  test("warn-only special types get a manual-review placeholder, never a body (W1 children)", async () => {
    const r = await run("privacy", "W1");
    expect(status(r.ast, "S04")).toBe("manual_review");
    expect(r.llm.calls.some((c) => c.user.includes('"id":"S04"'))).toBe(false);
  });

  test("fix loop: only sections with findings are redrafted, the rest are copied", async () => {
    const first = await run("privacy", "G1");
    const finding: Finding = { id: "F1", layer: "llm", ruleId: "R-S09-001", docType: "privacy", sectionId: "S09", severity: "major", message: "수탁자가 원장과 다릅니다.", evidence: { astPath: "sections[0]", quote: "x" }, fixHint: "원장의 수탁자를 사용하세요." };
    const llm = new MockLlmClient({ fixtures: { R5P: draftFixture } });
    const { ledger, applicability, selection } = first;
    const second = await draftDocument({ llm }, { docType: "privacy", runId: RUN_ID, effectiveDate: "2026-10-01", lawSnapshotId: "law-2026-09-29", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library, ruleSections, houseStyle, citations, previous: first.ast, fixFindings: [finding] });
    expect(llm.callCount()).toBe(1);
    expect(llm.calls[0]!.user).toContain("수탁자가 원장과 다릅니다");
    expect(second.ast.sections.find((s) => s.id === "S09")!.blocks).not.toEqual(first.ast.sections.find((s) => s.id === "S09")!.blocks);
    for (const s of first.ast.sections.filter((x) => x.id !== "S09")) expect(second.ast.sections.find((x) => x.id === s.id)).toEqual(s);
  });

  test("the draft is deterministic for the same mock output", async () => {
    const a = await run("privacy", "G1");
    const b = await run("privacy", "G1");
    expect(a.ast).toEqual(b.ast);
  });
});

describe("draftDocument (terms)", () => {
  test("G1 terms: T13 links the policy when the URL is known; otherwise manual review", async () => {
    const withUrl = await run("terms", "G1", library, undefined, { "terms.privacyPolicyUrl": "https://shop.example.com/privacy" });
    const t13 = withUrl.ast.sections.find((s) => s.id === "T13")!;
    expect(t13.status).toBe("drafted");
    expect(JSON.stringify(t13.blocks)).toContain("https://shop.example.com/privacy");
    const without = await run("terms", "G1", library, undefined, { "terms.privacyPolicyUrl": "needs_manual_review" });
    expect(status(without.ast, "T13")).toBe("manual_review");
    expect(without.ast.meta.models.R5T).toContain("sonnet");
  });

  test("each terms call sees which sibling article owns which facts; a fix pass sees the articles its findings name", async () => {
    const first = await run("terms", "G1");
    const t06 = first.llm.calls.find((c) => c.user.includes('"section":{"id":"T06"'))!;
    const outline = (JSON.parse(t06.user.slice(t06.user.indexOf("\n") + 1, t06.user.lastIndexOf("\n"))) as { documentOutline: { id: string; owns: string[] }[] }).documentOutline;
    expect(outline.map((o) => o.id)).not.toContain("T06");
    expect(outline.find((o) => o.id === "T07")!.owns).toContain("terms.membershipRules");
    const finding: Finding = { id: "F1", layer: "llm", ruleId: "R-T06-001", docType: "terms", sectionId: "T06", severity: "major", message: "T06 and T07 state the rejoin wait differently.", evidence: { astPath: "sections[0]", quote: "x" }, fixHint: "Align with T07." };
    const llm = new MockLlmClient({ fixtures: { R5T: draftFixture } });
    const { ledger, applicability, selection } = first;
    await draftDocument({ llm }, { docType: "terms", runId: RUN_ID, effectiveDate: "2026-10-01", lawSnapshotId: "law-2026-09-29", rulePackVersion: kb.rulePackVersion, ledger, applicability, selection, library, ruleSections, houseStyle, citations, previous: first.ast, fixFindings: [finding] });
    expect(llm.callCount()).toBe(1);
    const user = llm.calls[0]!.user;
    const related = (JSON.parse(user.slice(user.indexOf("\n") + 1, user.lastIndexOf("\n"))) as { relatedSections: { id: string; text: string }[] }).relatedSections;
    expect(related.map((r) => r.id)).toEqual(["T07"]);
    expect(related[0]!.text).toContain("초안");
  });

  test("privacy calls carry no document outline", async () => {
    const r = await run("privacy", "G1");
    expect(r.llm.calls.every((c) => !c.user.includes("documentOutline"))).toBe(true);
  });

  test("G2 has no terms document: nothing is drafted", async () => {
    const r = await run("terms", "G2");
    expect(r.ast.sections).toEqual([]);
    expect(r.llm.callCount()).toBe(0);
  });
});
