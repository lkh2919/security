/**
 * UsageRecord: one model call in `usage.jsonl` (design C3 Observability). One JSON object per line, no prompts, no values.
 * `costUsd` is the client-reported cost when the backend gives one (Claude Code), else the list-price estimate, else null.
 */
import { z } from "zod";
import { NonEmptyString } from "./common";

const Tokens = z.number().int().nonnegative();

export const UsageRecordSchema = z.strictObject({
  stage: NonEmptyString,
  model: NonEmptyString,
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheReadInputTokens: Tokens,
  cacheCreationInputTokens: Tokens,
  /** List-price USD from the price table in llm/models.ts; null when the model price is unknown. */
  listPriceUsd: z.number().nonnegative().nullable(),
  /** Backend-reported cost (Claude Code `total_cost_usd`), when present. */
  reportedCostUsd: z.number().nonnegative().nullable(),
  /** The figure used for totals: reported when present, else list price, else null. */
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.enum(["reported", "list-price", "unknown"]),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
