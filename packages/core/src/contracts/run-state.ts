/**
 * RunState: the orchestrator's resumable state (design R7). Persisted as `runs/<runId>/run-state.json`.
 */
import { z } from "zod";
import { DocTypeSchema, IsoDateTimeSchema, NonEmptyString, RunIdSchema, Sha256Schema } from "./common";
import { MAX_AUDIT_ITERATIONS } from "./audit-report";
import { MAX_INTERVIEW_ROUNDS } from "./question-set";
import { VersionStampsSchema } from "./manifest";

/**
 * Pipeline stages in execution order (design R7 state machine). The `daily-*` stages are the steps of the daily monitor chain
 * (design C3); they are appended so the artifact ordinals of the draft stages never change.
 */
export const PIPELINE_STAGES = ["intake", "mask", "extract", "coverage", "interview", "freshness", "match", "draft", "check", "audit", "render", "daily-freshness", "daily-impact", "daily-recheck", "daily-peers", "daily-digest"] as const;
export const PipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

/** 1-based ordinal used for artifact file names: `runs/<runId>/03-extract.json`. */
export function stageOrdinal(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage) + 1;
}

export const StageStatusSchema = z.enum(["pending", "running", "done", "failed", "skipped"]);

export const StageRecordSchema = z.strictObject({
  status: StageStatusSchema,
  /** Artifact file name relative to the run directory. */
  artifact: NonEmptyString.optional(),
  /** Stage-cache key of the last execution. */
  cacheKey: Sha256Schema.optional(),
  cacheHit: z.boolean().optional(),
  startedAt: IsoDateTimeSchema.optional(),
  finishedAt: IsoDateTimeSchema.optional(),
  /** Failure message; never contains transcript text or PII. */
  error: z.string().optional(),
});
export type StageRecord = z.infer<typeof StageRecordSchema>;

export const RunStatusSchema = z.enum(["running", "awaiting_answers", "failed", "done"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStateSchema = z
  .strictObject({
    runId: RunIdSchema,
    schemaVersion: z.literal(1),
    status: RunStatusSchema,
    /** Stage currently executing or where the run stopped. */
    currentStage: PipelineStageSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    interviewRound: z.number().int().min(0).max(MAX_INTERVIEW_ROUNDS),
    auditIteration: z.strictObject({
      privacy: z.number().int().min(0).max(MAX_AUDIT_ITERATIONS),
      terms: z.number().int().min(0).max(MAX_AUDIT_ITERATIONS),
    }),
    /** Documents that will be produced (terms may be not applicable). */
    documents: z.array(DocTypeSchema),
    /** Latest record per stage. Repeated stages (interview rounds, audit iterations) overwrite it. */
    stages: z.partialRecord(PipelineStageSchema, StageRecordSchema),
    stamps: VersionStampsSchema,
    /** Hash of the input snapshot (`00-input.json`). */
    inputHash: Sha256Schema,
  })
  .superRefine((state, ctx) => {
    if (state.status === "awaiting_answers" && state.currentStage !== "interview") {
      ctx.addIssue({ code: "custom", path: ["currentStage"], message: "awaiting_answers is only valid at the interview stage" });
    }
  });
export type RunState = z.infer<typeof RunStateSchema>;
