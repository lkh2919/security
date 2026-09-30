/**
 * AnthropicLlmClient: the real `LlmClient` (design R3 "Runtime API rules", R10, R11.3).
 *
 * Rules encoded here:
 *  - model ID, effort and token ceilings come from the pinned stage policy (`models.ts`); nothing is read from config;
 *  - structured output only (`output_config.format` built from the request's Zod schema); no forced `tool_choice`;
 *  - no sampling parameters, ever (`preflight` rejects them);
 *  - the static prefix (`request.system`) is a cached system block; volatile content stays in the user turn;
 *  - the server-side refusal fallback (`fallbacks: "default"`) is sent for models that support it (Sonnet/Opus 5.5).
 *    Haiku 4.5 has no server fallback: a refusal there surfaces as `LlmRefusalError` (callers mark `manual_review`);
 *  - `findVaultLeaks` (and, with `piiGate: true`, the intake residual-PII gate `assertNoPii`) run on every outgoing string before EVERY call,
 *    including the schema retry (masking is a hard gate);
 *  - 429 / 5xx / connection errors are retried with exponential backoff (SDK retries are disabled so the policy is ours);
 *  - schema-invalid output gets exactly one retry that carries the validator error (design R7 "Failures");
 *  - per-call token usage is appended to `usageLog`; the API key is never logged or put in an error message.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { ContractError } from "../contracts/common";
import type { PiiVault } from "../contracts/pii-vault";
import {
  LlmRefusalError,
  preflight,
  type LlmClient,
  type StructuredCallRequest,
  type StructuredCallResult,
  type TokenUsage,
} from "./client";
import { assertNoPii } from "../stages/intake/gate";
import { MODELS, getStagePolicy, type LlmStageId } from "./models";

/** Beta flag for `fallbacks: "default"`. */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Extra `max_tokens` room for models with adaptive thinking; thinking tokens count against `max_tokens`. */
export const THINKING_HEADROOM_TOKENS = 4_000;

export class LlmTruncatedError extends Error {
  constructor(readonly stageId: LlmStageId) {
    super(`[LLM_TRUNCATED] stage ${stageId} hit max_tokens before finishing the structured output`);
    this.name = "LlmTruncatedError";
  }
}

export class LlmTransportError extends Error {
  constructor(
    readonly stageId: LlmStageId,
    readonly status: number | undefined,
    message: string,
  ) {
    super(`[LLM_TRANSPORT] stage ${stageId}: ${message}`);
    this.name = "LlmTransportError";
  }
}

export interface CallUsageRecord {
  readonly stageId: LlmStageId;
  readonly modelId: string;
  readonly usage: TokenUsage;
  readonly usedFallback: boolean;
  /** 1-based transport attempt that produced this record (schema retries count as their own call). */
  readonly attempt: number;
  /** True for the single schema-retry call. */
  readonly schemaRetry: boolean;
}

export interface UsageTotals extends TokenUsage {
  readonly calls: number;
}

export interface AnthropicLlmClientOptions {
  /** Defaults to `process.env.ANTHROPIC_API_KEY`. Never logged. */
  readonly apiKey?: string;
  /** Pre-built SDK client (tests, proxies). When set, `apiKey`/`fetch`/`baseURL` are ignored. */
  readonly sdk?: Anthropic;
  /** Custom fetch (tests stub the transport here). */
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  /** Vault used for the leak scan. Strongly recommended; without it only the type-level guarantees apply. */
  readonly vault?: PiiVault;
  /** Run the intake residual-PII gate (`assertNoPii`) on outgoing strings. Default false (masking is off by default); the vault scan always runs. */
  readonly piiGate?: boolean;
  /** Total transport attempts per call (first try + retries). Default 4. */
  readonly maxAttempts?: number;
  /** First backoff delay; doubles per retry. Default 1000 ms. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injectable sleep so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    return s === 429 || s === 408 || (typeof s === "number" && s >= 500);
  }
  return false;
}

function errorMessage(err: unknown): string {
  // SDK error messages carry status + API error body, never the request headers.
  return err instanceof Error ? err.message.slice(0, 300) : "unknown error";
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  iterations?: Array<{ type?: string }> | null;
}

interface RawMessage {
  stop_reason?: string | null;
  content: Array<{ type: string; text?: string }>;
  usage: RawUsage;
}

export class AnthropicLlmClient implements LlmClient {
  /** Append-only per-call usage record. */
  readonly usageLog: CallUsageRecord[] = [];
  private readonly sdk: Anthropic;
  private readonly vault?: PiiVault;
  private readonly piiGate: boolean;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AnthropicLlmClientOptions = {}) {
    if (options.sdk) {
      this.sdk = options.sdk;
    } else {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("[LLM_CONFIG] ANTHROPIC_API_KEY is not set");
      this.sdk = new Anthropic({ apiKey, maxRetries: 0, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
    }
    this.vault = options.vault;
    this.piiGate = options.piiGate ?? false;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 20_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Sum of all recorded calls, optionally for one stage. */
  totals(stageId?: LlmStageId): UsageTotals {
    const rows = stageId ? this.usageLog.filter((r) => r.stageId === stageId) : this.usageLog;
    return rows.reduce<UsageTotals>(
      (acc, r) => ({
        calls: acc.calls + 1,
        inputTokens: acc.inputTokens + r.usage.inputTokens,
        outputTokens: acc.outputTokens + r.usage.outputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens + r.usage.cacheReadInputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens + r.usage.cacheCreationInputTokens,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    );
  }

  async callStructured<S extends z.ZodType>(request: StructuredCallRequest<S>): Promise<StructuredCallResult<z.infer<S>>> {
    // Hard gate: throws PiiLeakError / rejects sampling params BEFORE anything leaves the process.
    const { effort, modelId, fallback } = this.guard(request);
    const policy = getStagePolicy(request.stageId);
    const spec = MODELS[policy.modelAlias];
    const format = zodOutputFormat(request.schema);

    const build = (userText: string): Record<string, unknown> => ({
      model: modelId,
      max_tokens: policy.maxOutputTokens + (spec.supportsEffort ? THINKING_HEADROOM_TOKENS : 0),
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
      output_config: { ...(effort ? { effort } : {}), format: { type: "json_schema", schema: format.schema } },
      ...(fallback === "default" && spec.supportsEffort ? { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: "default" } : {}),
    });

    const first = await this.send(request.stageId, modelId, build(request.user), false);
    const firstTry = this.parse(request, first);
    if (firstTry.ok) return this.result(modelId, first, firstTry.data);

    // One schema retry that carries the validator error (design R7). The vault scan runs again on the new payload.
    const retryUser = `${request.user}\n\nYour previous output failed validation: ${firstTry.error}\nReturn a corrected JSON object that satisfies the schema.`;
    this.guard({ ...request, user: retryUser });
    const second = await this.send(request.stageId, modelId, build(retryUser), true);
    const secondTry = this.parse(request, second);
    if (secondTry.ok) return this.result(modelId, second, secondTry.data);
    throw new ContractError(`LLM output for ${request.stageId} (${request.schemaName})`, [secondTry.error]);
  }

  /**
   * Every outgoing string passes the vault scan (`preflight` -> `findVaultLeaks`, throws PiiLeakError);
   * with `piiGate: true` it also passes the intake residual-PII gate
   * (`assertNoPii`, throws PiiResidualError with kinds and offsets only, never values).
   * The residual gate is a broader net than the vault: it also catches PII the masker missed.
   */
  private guard(request: StructuredCallRequest): ReturnType<typeof preflight> {
    const pre = preflight(request, this.vault);
    if (this.piiGate) {
      const opts = this.vault ? { vault: this.vault } : {};
      assertNoPii(request.system, opts);
      assertNoPii(request.user, opts);
    }
    return pre;
  }

  private parse<S extends z.ZodType>(
    request: StructuredCallRequest<S>,
    message: RawMessage,
  ): { ok: true; data: z.infer<S> } | { ok: false; error: string } {
    const text = message.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: "output was not valid JSON" };
    }
    const parsed = request.schema.safeParse(json);
    if (parsed.success) return { ok: true, data: parsed.data as z.infer<S> };
    return { ok: false, error: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }

  private result<T>(modelId: string, message: RawMessage, data: T): StructuredCallResult<T> {
    return { data, modelId, stopReason: "end_turn", usedFallback: usedFallback(message.usage), usage: toUsage(message.usage) };
  }

  /** One logical call with transport retries. Records usage for each successful HTTP response. */
  private async send(stageId: LlmStageId, modelId: string, body: Record<string, unknown>, schemaRetry: boolean): Promise<RawMessage> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const message = (await this.sdk.beta.messages.create(body as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming)) as unknown as RawMessage;
        this.usageLog.push({ stageId, modelId, usage: toUsage(message.usage), usedFallback: usedFallback(message.usage), attempt, schemaRetry });
        if (message.stop_reason === "refusal") throw new LlmRefusalError(stageId);
        if (message.stop_reason === "max_tokens") throw new LlmTruncatedError(stageId);
        return message;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === this.maxAttempts) break;
        await this.sleep(Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
    if (lastErr instanceof LlmRefusalError || lastErr instanceof LlmTruncatedError) throw lastErr;
    throw new LlmTransportError(stageId, lastErr instanceof Anthropic.APIError ? lastErr.status : undefined, errorMessage(lastErr));
  }
}

function toUsage(u: RawUsage): TokenUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function usedFallback(u: RawUsage): boolean {
  return (u.iterations ?? []).some((i) => i.type === "fallback_message");
}
