/**
 * Golden cases (design R11.1): synthetic inputs, expected slots/applicability/phrases.
 * Deterministic part only (no LLM): inputs parse through intake, and C1 over the EXPECTED ledger must reproduce the
 * expected applicability and warnings. This pins the expectations to the rule packs: a rule-pack or template change
 * that shifts applicability fails here before any model call.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createFactLedgerSchema, type FactLedger, type SlotEntry } from "../src/contracts/fact-ledger";
import { JsonValueSchema } from "../src/contracts/common";
import { TextFileSttAdapter } from "../src/adapters/stt";
import { krPaths, loadKrKnowledge, runCoverage } from "../src/stages/coverage";
import { runIntake } from "../src/stages/intake";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CASES = join(ROOT, "golden", "cases");
const RUN_ID = "20260930-120000-0a1b2c";

const ExpectedSchema = z.strictObject({
  caseId: z.string(),
  synthetic: z.literal(true),
  scenario: z.string().min(1),
  slots: z.record(z.string(), JsonValueSchema),
  applicability: z.strictObject({
    documents: z.strictObject({ privacy: z.boolean(), terms: z.boolean() }),
    items: z.record(z.string(), z.enum(["yes", "no", "unknown", "pending"])),
    warnings: z.array(z.string()),
  }),
  requiredPhrases: z.strictObject({ privacy: z.array(z.string()).optional(), terms: z.array(z.string()).optional() }),
  forbiddenPhrases: z.array(z.string()),
  expectedVerdict: z.enum(["pass", "pass_with_warnings"]),
  notes: z.string(),
  followUps: z.array(z.strictObject({ date: z.string(), reason: z.string().min(1) })).optional(),
});

const kb = loadKrKnowledge(krPaths(ROOT));
const caseIds = readdirSync(CASES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

function ledgerFrom(slots: Record<string, unknown>): FactLedger {
  const out: Record<string, SlotEntry> = {};
  for (const [id, value] of Object.entries(slots)) {
    out[id] =
      value === "needs_manual_review"
        ? { status: "needs_manual_review", value: null, confidence: 0, evidence: [] }
        : { status: "filled", value: value as never, confidence: 1, evidence: [{ source: "user_confirmed", ref: "golden-expected", quote: "" }] };
  }
  return createFactLedgerSchema(kb.registry).parse({ runId: RUN_ID, jurisdiction: "kr", slotRegistryVersion: kb.registry.version, slots: out });
}

describe("golden set", () => {
  test("the required cases exist", () => expect(caseIds).toEqual(["G1", "G1b", "G2", "G2b", "G3", "W1", "W2", "W3", "W4"]));

  for (const id of caseIds) {
    const dir = join(CASES, id);
    describe(id, () => {
      const expected = ExpectedSchema.parse(JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")));

      test("expected.json is well formed and every expected slot is registered", () => {
        expect(expected.caseId).toBe(id);
        expect(Object.keys(expected.slots).filter((s) => !kb.registry.has(s))).toEqual([]);
        expect(existsSync(join(dir, "reference", "README.md"))).toBe(true);
      });

      test("inputs parse through intake (masking off keeps text as written)", async () => {
        const transcript = await new TextFileSttAdapter().transcribe(join(dir, "input", "transcript.ko.txt"));
        const form = readFileSync(join(dir, "input", "form.ko.txt"), "utf8");
        const r = runIntake({ runId: RUN_ID, transcript, form });
        expect(r.maskedTranscript.segments.length).toBeGreaterThan(3);
        expect(r.formSlots.serviceName.length).toBeGreaterThan(0);
        // The form's gate answers agree with the expected slots.
        for (const [slot, value] of Object.entries(r.formSlots.slots)) {
          const want = expected.slots[slot];
          if (want === undefined || want === "needs_manual_review") continue;
          const got = value === "예" ? true : value === "아니오" ? false : value;
          expect(got).toEqual(want as never);
        }
      });

      test("C1 over the expected ledger reproduces the expected applicability and warnings", () => {
        const { applicability } = runCoverage({
          runId: RUN_ID,
          ledger: ledgerFrom(expected.slots),
          template: kb.template,
          rulePackItems: kb.rulePackItems,
          termsItems: kb.termsItems,
          rulePackVersion: kb.rulePackVersion,
          termsPackAvailable: kb.termsPackAvailable,
        });
        expect({ privacy: applicability.documents.privacy.applicable, terms: applicability.documents.terms.applicable }).toEqual(expected.applicability.documents);
        const got = Object.fromEntries(Object.entries(applicability.items).map(([k, v]) => [k, v.state]));
        const want = expected.applicability.items;
        const diff = Object.keys(want).filter((k) => got[k] !== want[k]).map((k) => `${k}: expected ${want[k]}, got ${got[k]}`);
        expect(diff).toEqual([]);
        expect(applicability.warnings.map((w) => w.code).filter((c) => c !== "TERMS_PACK_PENDING").sort()).toEqual([...expected.applicability.warnings].sort());
      });
    });
  }
});
