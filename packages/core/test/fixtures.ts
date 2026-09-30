/** Valid sample objects for contract tests. Synthetic data only; no real personal data. */
import { createSlotRegistry } from "../src/contracts/common";
import type { AuditEnvelope } from "../src/contracts/audit-envelope";
import type { CheckResults } from "../src/contracts/check-results";
import type { FactLedger } from "../src/contracts/fact-ledger";
import type { FormSlots } from "../src/contracts/form-slots";
import type { MaskedTranscript } from "../src/contracts/masked-transcript";
import type { ApplicabilityMap } from "../src/contracts/applicability";
import type { PolicyAST } from "../src/contracts/ast";
import type { Manifest, VersionStamps } from "../src/contracts/manifest";

export const RUN_ID = "20260929-101500-a1b2c3";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const NOW = "2026-09-29T10:15:00.000Z";

export const slotRegistry = createSlotRegistry("test-1.0.0", [
  { id: "profile.orgNameRef", type: "text" },
  { id: "gate.membership", type: "yes_no" },
  { id: "gate.outsourcing", type: "yes_no" },
  { id: "privacy.S02_purposes", type: "multi" },
  { id: "privacy.S09_processors", type: "table" },
  { id: "terms.minAge", type: "number" },
]);

export const maskedTranscript: MaskedTranscript = {
  runId: RUN_ID,
  source: "text_file",
  language: "ko",
  maskerVersion: "0.1.0",
  segments: [
    { id: "T0001", speaker: "interviewer", text: "Do members sign up with an email address?" },
    { id: "T0002", speaker: "owner", text: "Yes, {{PERSON_1}} manages sign-up and we outsource mail delivery." },
  ],
  placeholders: [{ key: "PERSON_1", kind: "person", occurrences: 1 }],
};

export const formSlots: FormSlots = {
  runId: RUN_ID,
  formVersion: "builtin-1",
  serviceName: "Sample App",
  description: "A sample B2C app",
  slots: { "gate.membership": true },
  fields: { launchQuarter: "2026Q4" },
  flows: [{ name: "signup", dataItems: ["email"], purposes: ["account creation"], recipients: ["mail vendor"] }],
};

export const factLedger: FactLedger = {
  runId: RUN_ID,
  jurisdiction: "kr",
  slotRegistryVersion: "test-1.0.0",
  slots: {
    "gate.membership": {
      value: true,
      status: "filled",
      confidence: 0.95,
      evidence: [{ source: "transcript", segmentId: "T0001", quote: "sign up with an email" }],
    },
    "gate.outsourcing": {
      value: true,
      status: "filled",
      confidence: 0.8,
      evidence: [{ source: "transcript", segmentId: "T0002", quote: "we outsource mail delivery" }],
    },
    "terms.minAge": { value: null, status: "missing", confidence: 0, evidence: [] },
  },
};

export const applicability: ApplicabilityMap = {
  runId: RUN_ID,
  ruleSetVersions: ["privacy-2026.04"],
  documents: { privacy: { applicable: true }, terms: { applicable: true } },
  items: {
    S01: { state: "yes", basisSlots: [] },
    S09: { state: "yes", basisSlots: ["gate.outsourcing"] },
  },
  warnings: [],
};

export const policyAst: PolicyAST = {
  docType: "privacy",
  meta: {
    runId: RUN_ID,
    effectiveDate: "2026-10-01",
    rulePackVersion: "privacy-2026.04",
    clauseLibVersion: "clauses-0.1.0",
    houseStyleVersion: "hs-0.1.0",
    lawSnapshotId: "snap-20260929",
    promptVersions: { R5P: "1.0.0" },
    models: { R5P: "claude-sonnet-5-5" },
  },
  sections: [
    {
      id: "S09",
      title: "Outsourcing",
      status: "drafted",
      blocks: [
        {
          t: "para",
          runs: [
            { t: "text", text: "We outsource mail delivery. ", slotRef: "gate.outsourcing" },
            { t: "cite", citationId: "PIPA-26" },
          ],
        },
      ],
      trace: { slotRefs: ["gate.outsourcing"], clauseRefs: [], ruleRefs: ["R-S09-001"], styleRefs: [], citationIds: ["PIPA-26"] },
    },
  ],
  warnings: [],
};

export const checkResults: CheckResults = {
  runId: RUN_ID,
  docType: "privacy",
  passed: true,
  checks: [{ checkId: "structure.no-unresolved-syntax", category: "structure", passed: true, findings: [] }],
};

export const envelope: AuditEnvelope = {
  docMarkdown: "# Privacy Policy\n\n## Outsourcing\nWe outsource mail delivery.",
  astSummary: [{ sectionId: "S09", title: "Outsourcing", status: "drafted", slotRefs: ["gate.outsourcing"], citationIds: ["PIPA-26"] }],
  factLedger,
  maskedTranscript,
  formSlots,
  applicability,
  mustRuleDigest: [{ ruleId: "R-S09-001", sectionId: "S09", statement: "Name each processor.", legalRefs: ["PIPA:26"] }],
  rubricProfile: "privacy",
  houseStyle: [{ id: "H-01", scope: "both", kind: "llm", rule: "Use the term member." }],
  c2Results: checkResults,
  priorFindings: [],
  otherDocDigest: null,
};

export const manifest: Manifest = {
  manifestVersion: "0.1.0",
  rulePacks: [{ id: "privacy-2026.04", version: "2026.04", sha256: HASH_A }],
  lawSnapshot: { id: "snap-20260929", laws: [{ name: "PIPA", target: "law", id: "283839", effective: "2026-09-11" }] },
  clauseLib: { version: "clauses-0.1.0", capturedAt: NOW, sites: ["https://example.com/privacy"], vettedClauses: 12 },
  houseStyle: { version: "hs-0.1.0" },
  pages: [{ url: "https://example.com/guideline", titleHash: HASH_B, checkedAt: NOW }],
};

export const stamps: VersionStamps = {
  manifestVersion: "0.1.0",
  rulePacks: { "privacy-2026.04": "2026.04" },
  lawSnapshotId: "snap-20260929",
  clauseLibVersion: "clauses-0.1.0",
  houseStyleVersion: "hs-0.1.0",
  interviewTemplateVersion: "1.0.0",
  slotRegistryVersion: "test-1.0.0",
  prompts: { R2: "1.0.0" },
};
