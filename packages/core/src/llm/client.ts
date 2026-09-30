/**
 * LLM client interface and a deterministic mock for tests. No SDK dependency in this row.
 *
 * The request type has no sampling parameters by construction, and `assertNoSamplingParams`
 * rejects them at runtime for callers that bypass the type system. Structured output is the
 * only call shape: a Zod schema is mandatory and the result is validated against it.
 */
import type { z } from "zod";
import { ContractError } from "../contracts/common";
import { findVaultLeaks, type PiiVault } from "../contracts/pii-vault";
import { FORBIDDEN_SAMPLING_PARAMS, MODELS, getStagePolicy, type Effort, type LlmStageId } from "./models";

export type RefusalFallback = "default" | "none";

export interface StructuredCallRequest<S extends z.ZodType = z.ZodType> {
  readonly stageId: LlmStageId;
  /** Frozen, cacheable prefix (role, house style, glossary). No timestamps, sorted JSON keys. */
  readonly system: string;
  /** Volatile per-call content placed after the cache breakpoint. Masked text only. */
  readonly user: string;
  /** Output schema; sent as `output_config.format`. */
  readonly schema: S;
  readonly schemaName: string;
  /** Semver of the prompt file. Part of the stage-cache key. */
  readonly promptVersion: string;
  /** Overrides the stage's default effort. Rejected for models without effort control. */
  readonly effort?: Effort;
  /** Server-side refusal fallback. Defaults to the stage policy (`default`). */
  readonly fallback?: RefusalFallback;
  /** Structural ban on sampling parameters. */
  readonly temperature?: never;
  readonly top_p?: never;
  readonly top_k?: never;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface StructuredCallResult<T> {
  readonly data: T;
  readonly modelId: string;
  readonly stopReason: "end_turn" | "max_tokens";
  /** True when the server-side refusal fallback answered instead of the primary model. */
  readonly usedFallback: boolean;
  readonly usage: TokenUsage;
}

export interface LlmClient {
  callStructured<S extends z.ZodType>(request: StructuredCallRequest<S>): Promise<StructuredCallResult<z.infer<S>>>;
}

/** Thrown when the model refused and no fallback produced an answer; callers mark `manual_review`. */
export class LlmRefusalError extends Error {
  constructor(readonly stageId: LlmStageId) {
    super(`[LLM_REFUSAL] stage ${stageId} was refused`);
    this.name = "LlmRefusalError";
  }
}

/** Thrown when a payload contains a PiiVault value. Masking is a hard gate. */
export class PiiLeakError extends Error {
  constructor(
    readonly stageId: LlmStageId,
    readonly placeholderKeys: readonly string[],
  ) {
    super(`[PII_LEAK] stage ${stageId} payload contains vault values for: ${placeholderKeys.join(", ")}`);
    this.name = "PiiLeakError";
  }
}

/** Runtime backstop for the `never` typing: throws when a sampling parameter is present. */
export function assertNoSamplingParams(request: object): void {
  for (const key of FORBIDDEN_SAMPLING_PARAMS) {
    if (key in request) throw new Error(`[LLM_REQUEST] sampling parameter "${key}" must not be sent (Opus/Sonnet 5.5 reject it)`);
  }
}

/** Resolves the effort to send, enforcing the model's capability. */
export function resolveEffort(request: Pick<StructuredCallRequest, "stageId" | "effort">): Effort | null {
  const policy = getStagePolicy(request.stageId);
  if (request.effort === undefined) return policy.effort;
  if (!MODELS[policy.modelAlias].supportsEffort) {
    throw new Error(`[LLM_REQUEST] stage ${request.stageId}: ${policy.modelId} has no effort control`);
  }
  return request.effort;
}

/** Shared pre-flight checks used by every client implementation. */
export function preflight(request: StructuredCallRequest, vault?: PiiVault): { effort: Effort | null; modelId: string; fallback: RefusalFallback } {
  assertNoSamplingParams(request);
  const policy = getStagePolicy(request.stageId);
  if (vault) {
    const leaks = findVaultLeaks(`${request.system}\n${request.user}`, vault);
    if (leaks.length > 0) throw new PiiLeakError(request.stageId, leaks);
  }
  return { effort: resolveEffort(request), modelId: policy.modelId, fallback: request.fallback ?? policy.refusalFallback };
}

export interface RecordedCall {
  readonly stageId: LlmStageId;
  readonly modelId: string;
  readonly effort: Effort | null;
  readonly fallback: RefusalFallback;
  readonly promptVersion: string;
  readonly schemaName: string;
  readonly system: string;
  readonly user: string;
}

export type MockFixture = unknown | ((request: StructuredCallRequest) => unknown);

export interface MockLlmClientOptions {
  /** Fixture (value or function) per stage. Missing stage -> throws, so tests cannot silently pass. */
  readonly fixtures: Partial<Record<LlmStageId, MockFixture>>;
  /** When set, payloads are scanned for vault values exactly like the real client must do. */
  readonly vault?: PiiVault;
  /** Stages that simulate a refusal. `usedFallback` decides whether the fallback rescues them. */
  readonly refuse?: Partial<Record<LlmStageId, { fallbackRescues: boolean }>>;
}

/** Deterministic client returning fixtures; validates every fixture against the request schema. */
export class MockLlmClient implements LlmClient {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly options: MockLlmClientOptions) {}

  callCount(stageId?: LlmStageId): number {
    return stageId ? this.calls.filter((c) => c.stageId === stageId).length : this.calls.length;
  }

  async callStructured<S extends z.ZodType>(request: StructuredCallRequest<S>): Promise<StructuredCallResult<z.infer<S>>> {
    const { effort, modelId, fallback } = preflight(request, this.options.vault);
    this.calls.push({
      stageId: request.stageId,
      modelId,
      effort,
      fallback,
      promptVersion: request.promptVersion,
      schemaName: request.schemaName,
      system: request.system,
      user: request.user,
    });

    const refusal = this.options.refuse?.[request.stageId];
    let usedFallback = false;
    if (refusal) {
      if (fallback === "default" && refusal.fallbackRescues) usedFallback = true;
      else throw new LlmRefusalError(request.stageId);
    }

    if (!(request.stageId in this.options.fixtures)) throw new Error(`[MOCK_LLM] no fixture for stage ${request.stageId}`);
    const fixture = this.options.fixtures[request.stageId];
    const raw = typeof fixture === "function" ? (fixture as (r: StructuredCallRequest) => unknown)(request) : fixture;

    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new ContractError(
        `mock fixture for ${request.stageId} (${request.schemaName})`,
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    return {
      data: parsed.data as z.infer<S>,
      modelId,
      stopReason: "end_turn",
      usedFallback,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}
