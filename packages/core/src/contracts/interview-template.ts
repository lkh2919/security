/**
 * Branching Interview Template (design R4.4). Content is authored under `kb/`; this schema only
 * validates its structure. Module IDs are plain strings (not a closed enum) because the module
 * list is template content; C1 checks module coverage.
 */
import { z } from "zod";
import { CondSchema, ItemIdSchema, NonEmptyString, SlotIdSchema, VersionSchema, condSlotIds, unknownSlotIds, type SlotRegistry } from "./common";
import { AnswerTypeSchema } from "./question-set";
import { QuestionIdSchema } from "./gap-list";

export const QuestionNodeSchema = z.strictObject({
  id: QuestionIdSchema,
  text: NonEmptyString,
  help: z.string().optional(),
  answerType: AnswerTypeSchema,
  options: z.array(NonEmptyString).optional(),
  /** Slot paths the answer fills. */
  targets: z.array(SlotIdSchema).min(1),
  itemRefs: z.array(ItemIdSchema).min(1),
  showIf: CondSchema.optional(),
  priority: z.enum(["must", "should"]),
  /** What R2 listens for in the transcript when extracting this answer. */
  evidenceHint: NonEmptyString,
});
export type QuestionNode = z.infer<typeof QuestionNodeSchema>;

export const InterviewModuleSchema = z.strictObject({
  id: NonEmptyString,
  enterIf: CondSchema,
  nodes: z.array(QuestionNodeSchema).min(1),
});

export const InterviewTemplateSchema = z
  .strictObject({
    version: VersionSchema,
    rulePackVersions: z.array(NonEmptyString),
    modules: z.array(InterviewModuleSchema).min(1),
  })
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    t.modules.forEach((m, mi) =>
      m.nodes.forEach((n, ni) => {
        if (seen.has(n.id)) ctx.addIssue({ code: "custom", path: ["modules", mi, "nodes", ni, "id"], message: `duplicate question id ${n.id}` });
        seen.add(n.id);
      }),
    );
  });
export type InterviewTemplate = z.infer<typeof InterviewTemplateSchema>;

/** Every slot referenced by targets or conditions, for registry cross-checking. */
export function templateSlotIds(template: InterviewTemplate): string[] {
  const ids: string[] = [];
  for (const m of template.modules) {
    ids.push(...condSlotIds(m.enterIf));
    for (const n of m.nodes) {
      ids.push(...n.targets);
      if (n.showIf) ids.push(...condSlotIds(n.showIf));
    }
  }
  return ids;
}

/** Returns slot IDs used by the template that the registry does not define. */
export function templateUnknownSlots(template: InterviewTemplate, registry: SlotRegistry): string[] {
  return unknownSlotIds(registry, templateSlotIds(template));
}
