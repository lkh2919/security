import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  ApplicabilityMapSchema,
  AuditReportSchema,
  CheckResultsSchema,
  ClauseRecordSchema,
  ClauseSelectionSchema,
  ContractError,
  FactLedgerSchema,
  FormSlotsSchema,
  FreshnessReportSchema,
  GapListSchema,
  InterviewTemplateSchema,
  ManifestSchema,
  MaskedTranscriptSchema,
  PiiVaultSchema,
  PolicyASTSchema,
  QuestionSetSchema,
  RunStateSchema,
  TermsASTSchema,
  VettedClauseRecordSchema,
  collectCitationIds,
  collectSlotRefs,
  createFactLedgerSchema,
  createSlotRegistry,
  findVaultLeaks,
  parseContract,
  rehydrate,
  slotIdSchemaFor,
  slotRegistryFromJson,
  stampsFromManifest,
  templateUnknownSlots,
  verifyTranscriptEvidence,
  type ClauseRecord,
} from "../src/contracts";
import { applicability, factLedger, formSlots, HASH_A, manifest, maskedTranscript, NOW, policyAst, RUN_ID, slotRegistry, stamps } from "./fixtures";

const clone = <T>(v: T): T => structuredClone(v);
const roundTrip = (schema: z.ZodType, value: unknown) => expect(schema.parse(value)).toEqual(value);

describe("FormSlots / MaskedTranscript / PiiVault", () => {
  test("valid form and transcript round-trip", () => {
    roundTrip(FormSlotsSchema, formSlots);
    roundTrip(MaskedTranscriptSchema, maskedTranscript);
  });

  test("form rejects extra keys and malformed slot ids", () => {
    expect(FormSlotsSchema.safeParse({ ...formSlots, extra: 1 }).success).toBe(false);
    expect(FormSlotsSchema.safeParse({ ...formSlots, slots: { "NotASlot": true } }).success).toBe(false);
  });

  test("transcript rejects bad and duplicate segment ids", () => {
    const bad = clone(maskedTranscript);
    bad.segments[0].id = "seg1";
    expect(MaskedTranscriptSchema.safeParse(bad).success).toBe(false);
    const dup = clone(maskedTranscript);
    dup.segments[1].id = "T0001";
    expect(MaskedTranscriptSchema.safeParse(dup).success).toBe(false);
  });

  test("vault round-trip; leak scan finds vault values but not placeholders", () => {
    const vault = PiiVaultSchema.parse({ runId: RUN_ID, entries: { PERSON_1: { kind: "person", value: "Hong Gildong" } } });
    expect(findVaultLeaks({ text: "hello {{PERSON_1}}" }, vault)).toEqual([]);
    expect(findVaultLeaks({ text: "hello Hong Gildong" }, vault)).toEqual(["PERSON_1"]);
    expect(findVaultLeaks("Hong Gildong", vault)).toEqual(["PERSON_1"]);
    expect(rehydrate("hello {{PERSON_1}} {{PERSON_2}}", vault)).toBe("hello Hong Gildong {{PERSON_2}}");
  });
});

describe("slot registry", () => {
  test("rejects duplicate and malformed ids", () => {
    expect(() => createSlotRegistry("1", [{ id: "a.b", type: "text" }, { id: "a.b", type: "text" }])).toThrow();
    expect(() => createSlotRegistry("1", [{ id: "nogroup", type: "text" }])).toThrow();
  });

  test("builds from slots.json shape, tolerating extra per-slot keys", () => {
    const reg = slotRegistryFromJson({ version: "1.0.0", note: "x", slots: [{ id: "gate.membership", type: "yes_no", inR43: true, columns: ["a"] }] });
    expect(reg.has("gate.membership")).toBe(true);
    expect(reg.has("gate.other")).toBe(false);
    expect(slotIdSchemaFor(reg).safeParse("gate.other").success).toBe(false);
  });
});

describe("FactLedger", () => {
  test("valid ledger round-trips and passes registry check", () => {
    roundTrip(FactLedgerSchema, factLedger);
    expect(createFactLedgerSchema(slotRegistry).safeParse(factLedger).success).toBe(true);
  });

  test("filled slot needs value and evidence", () => {
    const noEvidence = clone(factLedger);
    noEvidence.slots["gate.membership"].evidence = [];
    expect(FactLedgerSchema.safeParse(noEvidence).success).toBe(false);
    const nullValue = clone(factLedger);
    nullValue.slots["gate.membership"].value = null;
    expect(FactLedgerSchema.safeParse(nullValue).success).toBe(false);
  });

  test("missing slot must be null; confidence bounded; enum enforced", () => {
    const l1 = clone(factLedger);
    l1.slots["terms.minAge"].value = 14;
    expect(FactLedgerSchema.safeParse(l1).success).toBe(false);
    const l2 = clone(factLedger);
    l2.slots["gate.membership"].confidence = 1.5;
    expect(FactLedgerSchema.safeParse(l2).success).toBe(false);
    const l3 = clone(factLedger) as unknown as { slots: Record<string, { status: string }> };
    l3.slots["gate.membership"].status = "maybe";
    expect(FactLedgerSchema.safeParse(l3).success).toBe(false);
  });

  test("registry-aware schema rejects unknown slot ids and version drift", () => {
    const unknown = clone(factLedger);
    unknown.slots["gate.notInRegistry"] = { value: null, status: "missing", confidence: 0, evidence: [] };
    expect(createFactLedgerSchema(slotRegistry).safeParse(unknown).success).toBe(false);
    const drift = { ...clone(factLedger), slotRegistryVersion: "other" };
    expect(createFactLedgerSchema(slotRegistry).safeParse(drift).success).toBe(false);
  });

  test("evidence quotes longer than 300 chars are rejected", () => {
    const l = clone(factLedger);
    l.slots["gate.membership"].evidence = [{ source: "transcript", segmentId: "T0001", quote: "x".repeat(301) }];
    expect(FactLedgerSchema.safeParse(l).success).toBe(false);
  });

  test("verifyTranscriptEvidence flags missing segments and non-substring quotes", () => {
    expect(verifyTranscriptEvidence(factLedger, maskedTranscript)).toEqual([]);
    const l = clone(factLedger);
    l.slots["gate.membership"].evidence = [{ source: "transcript", segmentId: "T0099", quote: "x" }];
    l.slots["gate.outsourcing"].evidence = [{ source: "transcript", segmentId: "T0002", quote: "invented quote" }];
    const problems = verifyTranscriptEvidence(l, maskedTranscript);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("T0099");
    expect(problems[1]).toContain("substring");
  });
});

describe("ApplicabilityMap / GapList / QuestionSet", () => {
  test("applicability valid; non-applicable document needs a reason", () => {
    roundTrip(ApplicabilityMapSchema, applicability);
    const bad = clone(applicability);
    bad.documents.terms = { applicable: false };
    expect(ApplicabilityMapSchema.safeParse(bad).success).toBe(false);
    bad.documents.terms = { applicable: false, reason: "internal HR system" };
    expect(ApplicabilityMapSchema.safeParse(bad).success).toBe(true);
  });

  test("applicability rejects bad item keys", () => {
    const bad = clone(applicability) as unknown as { items: Record<string, unknown> };
    bad.items["S99x"] = { state: "yes", basisSlots: [] };
    expect(ApplicabilityMapSchema.safeParse(bad).success).toBe(false);
  });

  test("gap list valid and invalid", () => {
    const gap = { questionId: "Q-S09-02", itemRefs: ["S09"], targets: ["privacy.S09_processors"], priority: "must", reason: "missing" };
    const list = { runId: RUN_ID, templateVersion: "1.0.0", round: 0, gaps: [gap], warnings: [] };
    roundTrip(GapListSchema, list);
    expect(GapListSchema.safeParse({ ...list, gaps: [{ ...gap, questionId: "S09-02" }] }).success).toBe(false);
    expect(GapListSchema.safeParse({ ...list, round: 3 }).success).toBe(false);
  });

  test("question set is capped at 10 questions and 2 rounds", () => {
    const q = (i: number) => ({
      id: `Q-S09-0${i}`,
      text: "Do you use processors?",
      answerType: "yes_no",
      targets: ["gate.outsourcing"],
      itemRefs: ["S09"],
      priority: "must",
      origin: "template",
      sourceQuestionIds: [`Q-S09-0${i}`],
    });
    const ok = { runId: RUN_ID, round: 1, questions: Array.from({ length: 10 }, (_, i) => q(i % 10)) };
    expect(QuestionSetSchema.safeParse(ok).success).toBe(true);
    expect(QuestionSetSchema.safeParse({ ...ok, questions: [...ok.questions, q(1)] }).success).toBe(false);
    expect(QuestionSetSchema.safeParse({ ...ok, round: 3 }).success).toBe(false);
  });
});

describe("ClauseRecord / ClauseSelection", () => {
  const clause: ClauseRecord = {
    clauseId: "C-S09-001",
    docType: "privacy",
    itemIds: ["S09"],
    body: "We outsource {{task}}.",
    vars: [{ name: "task", slotPath: "privacy.S09_processors" }],
    conditions: [{ slot: "gate.outsourcing", op: "truthy" }],
    provenance: {
      sourceUrl: "https://example.com/privacy",
      affiliate: "Example Affiliate",
      businessGroup: "it-services",
      captureDate: "2026-10-01",
      contentHash: HASH_A,
    },
    vetted: true,
    vettedAgainst: "privacy-2026.04",
    styleRefs: ["H-01"],
  };

  test("clause record valid, nested conditions parse, bad hash rejected", () => {
    roundTrip(ClauseRecordSchema, clause);
    const nested = { ...clone(clause), conditions: [{ all: [{ slot: "gate.membership", op: "truthy" }, { not: { slot: "gate.outsourcing", op: "eq", value: false } }] }] };
    expect(ClauseRecordSchema.safeParse(nested).success).toBe(true);
    expect(ClauseRecordSchema.safeParse({ ...clone(clause), provenance: { ...clause.provenance, contentHash: "xyz" } }).success).toBe(false);
    expect(ClauseRecordSchema.safeParse({ ...clone(clause), conditions: [{ slot: "gate.x", op: "bogus" }] }).success).toBe(false);
  });

  test("only vetted clauses with vettedAgainst pass the vetted schema", () => {
    expect(VettedClauseRecordSchema.safeParse(clause).success).toBe(true);
    expect(VettedClauseRecordSchema.safeParse({ ...clone(clause), vetted: false }).success).toBe(false);
    expect(VettedClauseRecordSchema.safeParse({ ...clone(clause), vettedAgainst: undefined }).success).toBe(false);
  });

  test("clause selection valid and strict", () => {
    const sel = {
      runId: RUN_ID,
      clauseLibVersion: "clauses-0.1.0",
      houseStyleVersion: "hs-0.1.0",
      businessGroup: "it-services",
      groupMethod: "rule",
      sections: { S09: { candidates: [{ clauseId: "C-S09-001", rank: 1, coverage: "full", missingVars: [] }], styleRefs: [] } },
    };
    roundTrip(ClauseSelectionSchema, sel);
    expect(ClauseSelectionSchema.safeParse({ ...sel, groupMethod: "guess" }).success).toBe(false);
    expect(ClauseSelectionSchema.safeParse({ ...sel, extra: true }).success).toBe(false);
  });
});

describe("Interview template", () => {
  const template = {
    version: "1.0.0",
    rulePackVersions: ["privacy-2026.04"],
    modules: [
      {
        id: "core",
        enterIf: { all: [{ slot: "gate.membership", op: "exists" }] },
        nodes: [
          {
            id: "Q-S09-01",
            text: "Do you outsource processing?",
            answerType: "yes_no",
            targets: ["gate.outsourcing"],
            itemRefs: ["S09"],
            priority: "must",
            evidenceHint: "vendor, outsourcing",
            showIf: { slot: "gate.other", op: "truthy" },
          },
        ],
      },
    ],
  };

  test("valid template parses; unknown slots are reported against the registry", () => {
    const parsed = InterviewTemplateSchema.parse(template);
    expect(templateUnknownSlots(parsed, slotRegistry)).toEqual(["gate.other"]);
  });

  test("duplicate question ids and empty modules are rejected", () => {
    const dup = clone(template);
    dup.modules[0].nodes.push(clone(dup.modules[0].nodes[0]));
    expect(InterviewTemplateSchema.safeParse(dup).success).toBe(false);
    expect(InterviewTemplateSchema.safeParse({ ...template, modules: [] }).success).toBe(false);
  });
});

describe("AST", () => {
  test("policy AST valid; walkers collect slot refs and citations", () => {
    roundTrip(PolicyASTSchema, policyAst);
    expect(collectSlotRefs(policyAst.sections[0])).toEqual(["gate.outsourcing"]);
    expect(collectCitationIds(policyAst.sections[0])).toEqual(["PIPA-26"]);
  });

  test("terms schema rejects a privacy document and vice versa", () => {
    expect(TermsASTSchema.safeParse(policyAst).success).toBe(false);
    const terms = { ...clone(policyAst), docType: "terms" };
    expect(TermsASTSchema.safeParse(terms).success).toBe(false); // S09 section in a terms doc
    terms.sections[0].id = "T09";
    expect(TermsASTSchema.safeParse(terms).success).toBe(true);
  });

  test("rejects unknown inline type, duplicate section ids, and bad effectiveDate", () => {
    const badInline = clone(policyAst) as unknown as { sections: Array<{ blocks: Array<{ runs: unknown[] }> }> };
    badInline.sections[0].blocks[0].runs.push({ t: "html", raw: "<b>" });
    expect(PolicyASTSchema.safeParse(badInline).success).toBe(false);
    const dup = clone(policyAst);
    dup.sections.push(clone(dup.sections[0]));
    expect(PolicyASTSchema.safeParse(dup).success).toBe(false);
    const date = clone(policyAst);
    date.meta.effectiveDate = "10/01/2026";
    expect(PolicyASTSchema.safeParse(date).success).toBe(false);
  });
});

describe("Findings, CheckResults, AuditReport", () => {
  const finding = {
    id: "F-001",
    layer: "llm",
    ruleId: "R-S05-002",
    docType: "privacy",
    sectionId: "S05",
    severity: "major",
    message: "Retention basis missing",
    evidence: { astPath: "sections[0].blocks[0]", quote: "retained for a while" },
    fixHint: "State the statutory period",
  };
  const report = {
    runId: RUN_ID,
    docType: "privacy",
    iteration: 1,
    envelopeHash: HASH_A,
    rubricVersion: "rubric-1.0.0",
    profile: "privacy",
    scores: { legal: 3, accuracy: 4, clarity: 4, houseStyle: 4, consistency: 5 },
    verdict: "fail",
    findings: [finding],
    resolvedFindingIds: [],
  };

  test("audit report valid; iteration capped at 3; scores 0-5", () => {
    roundTrip(AuditReportSchema, report);
    expect(AuditReportSchema.safeParse({ ...report, iteration: 4 }).success).toBe(false);
    expect(AuditReportSchema.safeParse({ ...report, scores: { ...report.scores, legal: 6 } }).success).toBe(false);
  });

  test("verdict pass is incompatible with major findings; duplicate finding ids rejected", () => {
    expect(AuditReportSchema.safeParse({ ...report, verdict: "pass" }).success).toBe(false);
    expect(AuditReportSchema.safeParse({ ...report, findings: [finding, finding] }).success).toBe(false);
  });

  test("finding evidence quote max length and severity enum", () => {
    expect(AuditReportSchema.safeParse({ ...report, findings: [{ ...finding, evidence: { astPath: "a", quote: "x".repeat(301) } }] }).success).toBe(false);
    expect(AuditReportSchema.safeParse({ ...report, findings: [{ ...finding, severity: "critical" }] }).success).toBe(false);
  });

  test("check results: passed must match checks; failed check needs findings", () => {
    const ok = { runId: RUN_ID, docType: "privacy", passed: true, checks: [{ checkId: "c1", category: "structure", passed: true, findings: [] }] };
    roundTrip(CheckResultsSchema, ok);
    expect(CheckResultsSchema.safeParse({ ...ok, passed: false }).success).toBe(false);
    const failing = { ...ok, passed: false, checks: [{ checkId: "c1", category: "structure", passed: false, findings: [] }] };
    expect(CheckResultsSchema.safeParse(failing).success).toBe(false);
    failing.checks[0].findings = [{ ...finding, layer: "deterministic" }] as never;
    expect(CheckResultsSchema.safeParse(failing).success).toBe(true);
  });
});

describe("FreshnessReport / Manifest / RunState", () => {
  const source = { sourceId: "pipa", kind: "law_api", name: "PIPA", stampedVersion: "283839", observedVersion: "289415", outcome: "changed", fallbackUsed: false };
  const freshness = {
    runId: RUN_ID,
    checkedAt: NOW,
    validUntil: "2026-09-30T10:15:00.000Z",
    status: "drift",
    sources: [source],
    affectedSections: [{ itemId: "S05", sourceIds: ["pipa"], summary: "Retention rules changed" }],
  };

  test("freshness valid; drift requires a changed source; unverified requires all failed", () => {
    roundTrip(FreshnessReportSchema, freshness);
    expect(FreshnessReportSchema.safeParse({ ...freshness, sources: [{ ...source, outcome: "unchanged" }] }).success).toBe(false);
    const unverifiedOk = { ...freshness, status: "unverified", sources: [{ ...source, observedVersion: null, outcome: "check_failed" }], affectedSections: [] };
    expect(FreshnessReportSchema.safeParse(unverifiedOk).success).toBe(true);
    expect(FreshnessReportSchema.safeParse({ ...unverifiedOk, sources: [source] }).success).toBe(false);
  });

  test("manifest valid; bad sha and non-url site rejected; stamps derive from it", () => {
    roundTrip(ManifestSchema, manifest);
    const bad = clone(manifest);
    bad.rulePacks[0].sha256 = "nothex";
    expect(ManifestSchema.safeParse(bad).success).toBe(false);
    const bad2 = clone(manifest);
    bad2.clauseLib.sites = ["not a url"];
    expect(ManifestSchema.safeParse(bad2).success).toBe(false);
    expect(stampsFromManifest(manifest, { interviewTemplateVersion: "1.0.0", slotRegistryVersion: "test-1.0.0", prompts: { R2: "1.0.0" } })).toEqual(stamps);
  });

  const state = {
    runId: RUN_ID,
    schemaVersion: 1,
    status: "running",
    currentStage: "extract",
    createdAt: NOW,
    updatedAt: NOW,
    interviewRound: 0,
    auditIteration: { privacy: 0, terms: 0 },
    documents: ["privacy", "terms"],
    stages: { intake: { status: "done", artifact: "01-intake.json" } },
    stamps,
    inputHash: HASH_A,
  };

  test("run state valid; awaiting_answers only at interview; rounds and iterations bounded", () => {
    roundTrip(RunStateSchema, state);
    expect(RunStateSchema.safeParse({ ...state, status: "awaiting_answers" }).success).toBe(false);
    expect(RunStateSchema.safeParse({ ...state, status: "awaiting_answers", currentStage: "interview" }).success).toBe(true);
    expect(RunStateSchema.safeParse({ ...state, interviewRound: 3 }).success).toBe(false);
    expect(RunStateSchema.safeParse({ ...state, auditIteration: { privacy: 4, terms: 0 } }).success).toBe(false);
    expect(RunStateSchema.safeParse({ ...state, stages: { bogus: { status: "done" } } }).success).toBe(false);
  });
});

describe("parseContract", () => {
  test("throws ContractError with a [CONTRACT_ERROR] diagnostic listing field paths", () => {
    try {
      parseContract("FormSlots", FormSlotsSchema, { ...formSlots, serviceName: "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractError);
      expect((err as Error).message).toContain("[CONTRACT_ERROR] Invalid FormSlots");
      expect((err as Error).message).toContain("serviceName");
    }
  });
});
