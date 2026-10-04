/**
 * WatchRegistry (Policy Monitor design M5): `runs/monitor/registry.json`, gitignored. Keeps one entry per watched policy:
 * where it came from, the last SHA-256 seen and a pointer to the last report. An unchanged hash skips Mode A.
 * The registry holds no policy text and no contacts.
 */
import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyString, RunIdSchema, Sha256Schema } from "./common";
import { IngestFormatSchema, PolicyIdSchema } from "./ingested-policy";
import { MonitorSummarySchema } from "./monitor-report";

export const WatchEntrySchema = z.strictObject({
  policyId: PolicyIdSchema,
  source: z.strictObject({ path: NonEmptyString.optional(), url: NonEmptyString.optional(), format: IngestFormatSchema }),
  sha256: Sha256Schema,
  firstSeenAt: IsoDateTimeSchema,
  lastCheckedAt: IsoDateTimeSchema,
  lastReport: z.strictObject({ runId: RunIdSchema, checkedAt: IsoDateTimeSchema, summary: MonitorSummarySchema, file: NonEmptyString.optional() }).optional(),
});
export type WatchEntry = z.infer<typeof WatchEntrySchema>;

export const WatchRegistrySchema = z
  .strictObject({
    version: z.literal(1),
    updatedAt: IsoDateTimeSchema.nullable(),
    policies: z.record(PolicyIdSchema, WatchEntrySchema),
  })
  .superRefine((r, ctx) => {
    for (const [key, entry] of Object.entries(r.policies)) {
      if (entry.policyId !== key) ctx.addIssue({ code: "custom", path: ["policies", key, "policyId"], message: "entry policyId must equal its key" });
    }
  });
export type WatchRegistry = z.infer<typeof WatchRegistrySchema>;

export const EMPTY_REGISTRY: WatchRegistry = { version: 1, updatedAt: null, policies: {} };
