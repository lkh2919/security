/**
 * Pinned model registry and per-stage model policy (design R3 "Runtime API rules", R10, R11.3).
 *
 * Rules encoded here:
 *  - model IDs are pinned constants, never read from config or the environment;
 *  - every LLM output is structured output (`output_config.format`); forced `tool_choice` is not used;
 *  - effort is explicit per stage (`null` = the model has no effort control, e.g. Haiku);
 *  - sampling parameters (temperature, top_p, top_k) are never sent (Opus 5.5 and Sonnet 5.5 reject them);
 *  - the server-side refusal fallback is enabled (`fallbacks: "default"`).
 */

export type ModelAlias = "haiku" | "sonnet" | "opus";
export type ModelTier = "low" | "medium" | "high";
export type Effort = "low" | "medium" | "high";

export interface ModelSpec {
  readonly alias: ModelAlias;
  readonly id: string;
  readonly tier: ModelTier;
  /** Whether the model accepts the `effort` control. */
  readonly supportsEffort: boolean;
  /** Whether the model supports structured outputs (all pinned models do). */
  readonly structuredOutput: true;
  /** Sampling parameters are never sent to any pinned model. */
  readonly acceptsSamplingParams: false;
}

export const MODELS = {
  haiku: { alias: "haiku", id: "claude-haiku-4-5", tier: "low", supportsEffort: false, structuredOutput: true, acceptsSamplingParams: false },
  sonnet: { alias: "sonnet", id: "claude-sonnet-5-5", tier: "medium", supportsEffort: true, structuredOutput: true, acceptsSamplingParams: false },
  opus: { alias: "opus", id: "claude-opus-5-5", tier: "high", supportsEffort: true, structuredOutput: true, acceptsSamplingParams: false },
} as const satisfies Record<ModelAlias, ModelSpec>;

export const MODEL_ALIASES = Object.keys(MODELS) as ModelAlias[];

export function modelIdFor(alias: ModelAlias): string {
  return MODELS[alias].id;
}

/**
 * LLM-backed stage identifiers (design R3 roster). `R4-fallback` is the Haiku business-group fallback.
 * `M1` is the Policy Monitor judge (DEC-20261002-01): the published-policy check (Mode A) and the amendment-impact call (Mode B).
 */
export const LLM_STAGE_IDS = ["R2", "R3", "R4-fallback", "R5P", "R5T", "R6", "R7", "M1"] as const;
export type LlmStageId = (typeof LLM_STAGE_IDS)[number];

export interface StageModelPolicy {
  readonly stageId: LlmStageId;
  readonly modelAlias: ModelAlias;
  /** Pinned model ID, derived from `MODELS`. */
  readonly modelId: string;
  readonly tier: ModelTier;
  /** Explicit effort; `null` when the model has no effort control. */
  readonly effort: Effort | null;
  /** Budget per call. Input excludes the cached prefix accounting; it is the planning ceiling (R3). */
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Always true: every stage emits schema-bound structured output. */
  readonly structuredOutput: true;
  /** Server-side refusal fallback (`fallbacks: "default"`). */
  readonly refusalFallback: "default";
  /** Human-readable note for the budget row of the R3 table. */
  readonly note?: string;
}

function policy(
  stageId: LlmStageId,
  modelAlias: ModelAlias,
  effort: Effort | null,
  maxInputTokens: number,
  maxOutputTokens: number,
  note?: string,
): StageModelPolicy {
  const model = MODELS[modelAlias];
  if (effort !== null && !model.supportsEffort) throw new Error(`stage ${stageId}: ${model.id} does not support effort`);
  if (effort === null && model.supportsEffort) throw new Error(`stage ${stageId}: effort must be explicit for ${model.id}`);
  return { stageId, modelAlias, modelId: model.id, tier: model.tier, effort, maxInputTokens, maxOutputTokens, structuredOutput: true, refusalFallback: "default", note };
}

/** Budgets are from the R3 table (K = 1000 tokens). */
export const STAGE_MODEL_POLICIES: Readonly<Record<LlmStageId, StageModelPolicy>> = Object.freeze({
  R2: policy("R2", "haiku", null, 30_000, 6_000, "fact extractor; chunk long input"),
  R3: policy("R3", "sonnet", "low", 8_000, 2_000, "gap interviewer; max 2 rounds"),
  "R4-fallback": policy("R4-fallback", "haiku", null, 3_000, 500, "business-group classification fallback only"),
  R5P: policy("R5P", "sonnet", "medium", 6_000, 2_000, "privacy drafter, per LLM section"),
  R5T: policy("R5T", "sonnet", "medium", 6_000, 2_000, "terms drafter, per LLM section"),
  R6: policy("R6", "haiku", null, 4_000, 500, "freshness summary, per change"),
  R7: policy("R7", "opus", "high", 60_000, 6_000, "independent auditor, per document per iteration"),
  M1: policy("M1", "opus", "high", 30_000, 4_000, "policy monitor judge, per (policy, section); published text only, no ledger"),
});

export function getStagePolicy(stageId: LlmStageId): StageModelPolicy {
  return STAGE_MODEL_POLICIES[stageId];
}

/** Sampling parameter names that must never reach the API. */
export const FORBIDDEN_SAMPLING_PARAMS = ["temperature", "top_p", "top_k"] as const;
