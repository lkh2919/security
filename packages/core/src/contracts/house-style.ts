/**
 * House-style rules (design R5.4) as produced by the kb-curator candidate file
 * `kb/jurisdictions/kr/house-style/lotte-innovate.candidates.json` (Row 6b).
 *
 * PROVISIONAL: R5.4 sketched `{ id, scope, kind, rule, example, sourceClauseIds }`. The candidate file
 * uses `checkType` (regex | structure | manual) with `pattern` / `patternMode` / `structure`, plus
 * `rationale` and `evidence` (capture IDs). This schema follows the candidate file. `kind` is derived
 * (`deterministicKind`): regex rules are deterministic (C2), structure and manual rules go to the R7 LLM.
 * The approved `lotte-innovate.json` (user decision DEC-20260929-02, Q6) will add `status: "approved"`
 * and a file-level `version`; both variants are accepted here.
 */
import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyString, VersionSchema } from "./common";

export const HouseStyleScopeSchema = z.enum(["privacy", "terms", "both"]);
export const HouseStyleStatusSchema = z.enum(["candidate", "approved", "rejected"]);
export const HouseStyleCheckTypeSchema = z.enum(["regex", "structure", "manual"]);

export const HouseStyleFileRuleSchema = z
  .strictObject({
    /** `H-01`. */
    id: z.string().regex(/^H-\d{2,3}$/),
    scope: HouseStyleScopeSchema,
    /** Where the rule came from (`row6a-analysis`, `row6b-new`). */
    origin: NonEmptyString,
    status: HouseStyleStatusSchema,
    checkType: HouseStyleCheckTypeSchema,
    /** `require`: pattern must match; `forbid`: pattern must not match. Regex rules only. */
    patternMode: z.enum(["require", "forbid"]).optional(),
    /** JavaScript regex source (compiled with the `u` flag). Regex rules only. */
    pattern: NonEmptyString.optional(),
    /** Prose description of the structural requirement. Structure rules only. */
    structure: NonEmptyString.optional(),
    /** Korean rule text shown to drafters. */
    rule: NonEmptyString,
    rationale: NonEmptyString,
    /** Capture IDs that evidence the rule. */
    evidence: z.array(NonEmptyString).min(1),
  })
  .superRefine((r, ctx) => {
    if (r.checkType === "regex") {
      if (!r.pattern) ctx.addIssue({ code: "custom", path: ["pattern"], message: "regex rule needs a pattern" });
      if (!r.patternMode) ctx.addIssue({ code: "custom", path: ["patternMode"], message: "regex rule needs patternMode" });
      if (r.pattern) {
        try {
          new RegExp(r.pattern, "u");
        } catch (e) {
          ctx.addIssue({ code: "custom", path: ["pattern"], message: `pattern does not compile: ${(e as Error).message}` });
        }
      }
    } else if (r.pattern || r.patternMode) {
      ctx.addIssue({ code: "custom", path: ["pattern"], message: `${r.checkType} rule must not carry pattern/patternMode` });
    }
    if (r.checkType === "structure" && !r.structure) ctx.addIssue({ code: "custom", path: ["structure"], message: "structure rule needs a structure description" });
  });
export type HouseStyleFileRule = z.infer<typeof HouseStyleFileRuleSchema>;

export const deterministicKind = (r: Pick<HouseStyleFileRule, "checkType">): "deterministic" | "llm" => (r.checkType === "regex" ? "deterministic" : "llm");

export const HouseStyleFileSchema = z
  .strictObject({
    status: HouseStyleStatusSchema,
    note: z.string().optional(),
    builtAt: IsoDateTimeSchema.optional(),
    /** Present on the approved file. */
    version: VersionSchema.optional(),
    rules: z.array(HouseStyleFileRuleSchema),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.rules.forEach((r, i) => {
      if (seen.has(r.id)) ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: `duplicate house-style rule ${r.id}` });
      seen.add(r.id);
      if (f.status === "approved" && r.status !== "approved") ctx.addIssue({ code: "custom", path: ["rules", i, "status"], message: "approved file contains a non-approved rule" });
    });
    if (f.status === "approved" && !f.version) ctx.addIssue({ code: "custom", path: ["version"], message: "approved file needs a version" });
  });
export type HouseStyleFile = z.infer<typeof HouseStyleFileSchema>;

/**
 * Auditor-facing form (`AuditEnvelope.houseStyle`, audit-envelope.ts `HouseStyleRuleSchema`):
 * evidence, rationale and check internals are dropped, `kind` is derived from `checkType`.
 */
export function houseStyleDigest(r: HouseStyleFileRule): { id: string; scope: "privacy" | "terms" | "both"; kind: "deterministic" | "llm"; rule: string } {
  return { id: r.id, scope: r.scope, kind: deterministicKind(r), rule: r.rule };
}
