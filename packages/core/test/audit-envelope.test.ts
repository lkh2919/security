import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AUDIT_ENVELOPE_KEYS, AuditEnvelopeSchema, FORBIDDEN_ENVELOPE_FIELD_PATTERN, PiiVaultSchema, findVaultLeaks } from "../src/contracts";
import { envelope, RUN_ID } from "./fixtures";

/** Collects every property name in a JSON Schema tree (including $defs). */
function propertyNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((n) => propertyNames(n, out));
  } else if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (rec.properties && typeof rec.properties === "object") {
      for (const key of Object.keys(rec.properties as object)) out.add(key);
    }
    for (const value of Object.values(rec)) propertyNames(value, out);
  }
  return out;
}

describe("AuditEnvelope isolation (design R6.3, R17)", () => {
  test("a valid envelope parses", () => {
    expect(AuditEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  test("top-level keys are exactly the R6.3 allowlist", () => {
    expect([...AUDIT_ENVELOPE_KEYS]).toEqual(
      [
        "docMarkdown",
        "astSummary",
        "factLedger",
        "maskedTranscript",
        "formSlots",
        "applicability",
        "mustRuleDigest",
        "rubricProfile",
        "houseStyle",
        "c2Results",
        "priorFindings",
        "otherDocDigest",
      ].sort(),
    );
  });

  test.each(["drafterPrompt", "thinking", "reasoning", "rationale", "clauseSelection", "piiVault", "systemPrompt"])("rejects extra top-level key %s", (key) => {
    const result = AuditEnvelopeSchema.safeParse({ ...envelope, [key]: "leak" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });

  test("nested objects are strict as well (no smuggling through the ledger or AST summary)", () => {
    const viaLedger = { ...structuredClone(envelope), factLedger: { ...envelope.factLedger, thinking: "..." } };
    expect(AuditEnvelopeSchema.safeParse(viaLedger).success).toBe(false);
    const viaSummary = structuredClone(envelope) as unknown as { astSummary: Array<Record<string, unknown>> };
    viaSummary.astSummary[0].drafterPrompt = "...";
    expect(AuditEnvelopeSchema.safeParse(viaSummary).success).toBe(false);
    const viaFinding = structuredClone(envelope) as unknown as { priorFindings: unknown[] };
    viaFinding.priorFindings.push({ id: "F1", reasoning: "..." });
    expect(AuditEnvelopeSchema.safeParse(viaFinding).success).toBe(false);
  });

  test("no field anywhere in the envelope schema tree can carry prompts, reasoning, rationale, or vault data", () => {
    const names = propertyNames(z.toJSONSchema(AuditEnvelopeSchema, { unrepresentable: "any" }));
    expect(names.size).toBeGreaterThan(30);
    const forbidden = [...names].filter((n) => FORBIDDEN_ENVELOPE_FIELD_PATTERN.test(n));
    expect(forbidden).toEqual([]);
  });

  test("envelope content carries placeholders only: the vault leak scan is clean", () => {
    const vault = PiiVaultSchema.parse({ runId: RUN_ID, entries: { PERSON_1: { kind: "person", value: "Hong Gildong" } } });
    expect(findVaultLeaks(envelope, vault)).toEqual([]);
    const leaky = structuredClone(envelope);
    leaky.docMarkdown += "\nContact Hong Gildong";
    expect(findVaultLeaks(leaky, vault)).toEqual(["PERSON_1"]);
  });
});
