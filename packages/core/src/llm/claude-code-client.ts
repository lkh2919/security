/**
 * ClaudeCodeLlmClient: an `LlmClient` that answers through Claude Code in headless mode (`claude -p`) instead of the
 * Anthropic API, so the pipeline runs on the operator's Claude Code login with no API key.
 *
 * Contract is the same as `AnthropicLlmClient` (pinned model per stage policy, structured output from the request's Zod
 * schema, no sampling parameters, vault scan before every call, one schema retry, usage log). Differences, by design:
 *  - every call is a fresh, isolated process: no tools (`--tools ""`), no settings, skills, memory or project files
 *    (`--setting-sources ""`, empty working directory), no session persistence. The auditor therefore cannot see the
 *    repository, the drafters' work or this project's CLAUDE.md; it receives exactly the envelope in the request;
 *  - the system prompt travels as an argument (the CLI has no file option), so it is capped at 120 KB;
 *  - the user turn goes through stdin, never through argv or the process list;
 *  - the CLI has no server-side refusal fallback; a refusal or error surfaces as an error and callers mark `manual_review`;
 *  - the CLI reports cost on a list-price basis; on a subscription it counts against the plan's limits, not an API bill.
 *  - the child gets the parent environment minus credentials it does not need (`childEnv`): no law.go.kr key, no API key
 *    (so a stray `ANTHROPIC_API_KEY` can never turn a subscription run into an API bill), no cloud or GitHub tokens.
 * Prompts and outputs are never logged. Requires the `claude` CLI on PATH and a logged-in Claude Code.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { ContractError } from "../contracts/common";
import type { PiiVault } from "../contracts/pii-vault";
import { assertNoPii } from "../stages/intake/gate";
import { LlmRefusalError, preflight, type LlmClient, type StructuredCallRequest, type StructuredCallResult, type TokenUsage } from "./client";
import { MODELS, getStagePolicy, type LlmStageId } from "./models";

export const MAX_SYSTEM_PROMPT_BYTES = 120_000;

export interface CliRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI. Injectable so tests need no process and no login. */
export type CliRunner = (args: readonly string[], stdin: string, opts: { cwd: string; timeoutMs: number }) => Promise<CliRunResult>;

export interface ClaudeCodeClientOptions {
  /** Path or name of the CLI. Default `claude`. */
  readonly bin?: string;
  readonly vault?: PiiVault;
  /** Run the intake residual-PII gate on outgoing strings. Default false (masking is off by default). */
  readonly piiGate?: boolean;
  /** Pinned model ids (default, from the stage policy) or the CLI aliases `haiku|sonnet|opus`. */
  readonly models?: "pinned" | "alias";
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly timeoutMs?: number;
  readonly runner?: CliRunner;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class ClaudeCodeError extends Error {
  constructor(readonly stageId: LlmStageId, message: string) {
    super(`[CLAUDE_CODE] stage ${stageId}: ${message}`);
    this.name = "ClaudeCodeError";
  }
}

export interface ClaudeCodeUsageRecord {
  readonly stageId: LlmStageId;
  readonly modelId: string;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly attempt: number;
  readonly schemaRetry: boolean;
}

/** Variables never passed to the `claude` child. Claude Code's own login and proxy settings are kept. */
const CHILD_ENV_DENY = [/^LAW_GO_KR_OC$/, /^ANTHROPIC_API_KEY$/, /^ANTHROPIC_AUTH_TOKEN$/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^AWS_/, /^CLOUDSDK_AUTH_/, /^GOOGLE_APPLICATION_CREDENTIALS$/, /(^|_)SECRET(_|$)/, /(^|_)PASSWORD(_|$)/, /_API_KEY$/];

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !CHILD_ENV_DENY.some((re) => re.test(k))));
}

const defaultRunner = (bin: string): CliRunner => (args, stdin, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { cwd, env: childEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

interface CliJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  terminal_reason?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ClaudeCodeLlmClient implements LlmClient {
  readonly usageLog: ClaudeCodeUsageRecord[] = [];
  private readonly runner: CliRunner;
  private readonly workDir: string;
  private readonly vault?: PiiVault;
  private readonly piiGate: boolean;
  private readonly aliases: boolean;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClaudeCodeClientOptions = {}) {
    this.runner = options.runner ?? defaultRunner(options.bin ?? "claude");
    this.vault = options.vault;
    this.piiGate = options.piiGate ?? false;
    this.aliases = options.models === "alias";
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.sleep = options.sleep ?? defaultSleep;
    // Empty private working directory: the CLI finds no CLAUDE.md, skills or project files from here.
    this.workDir = mkdtempSync(join(tmpdir(), "pa-claude-code-"));
  }

  /** Removes the empty working directory. */
  close(): void {
    rmSync(this.workDir, { recursive: true, force: true });
  }

  totals(stageId?: LlmStageId): { calls: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUsd: number } {
    const rows = stageId ? this.usageLog.filter((r) => r.stageId === stageId) : this.usageLog;
    return rows.reduce(
      (a, r) => ({ calls: a.calls + 1, inputTokens: a.inputTokens + r.usage.inputTokens, outputTokens: a.outputTokens + r.usage.outputTokens, cacheReadInputTokens: a.cacheReadInputTokens + r.usage.cacheReadInputTokens, cacheCreationInputTokens: a.cacheCreationInputTokens + r.usage.cacheCreationInputTokens, costUsd: a.costUsd + r.costUsd }),
      { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 },
    );
  }

  async callStructured<S extends z.ZodType>(request: StructuredCallRequest<S>): Promise<StructuredCallResult<z.infer<S>>> {
    const pre = this.guard(request);
    if (Buffer.byteLength(request.system, "utf8") > MAX_SYSTEM_PROMPT_BYTES) {
      throw new ClaudeCodeError(request.stageId, `system prompt is larger than ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
    }
    const schema = zodOutputFormat(request.schema).schema;

    const first = await this.send(request, pre.modelId, pre.effort, schema, request.user, false);
    const firstTry = this.parse(request, first);
    if (firstTry.ok) return this.result(pre.modelId, first, firstTry.data);

    // One schema retry that carries the validator error (design R7), vault scan repeated on the new payload.
    const retryUser = `${request.user}\n\nYour previous output failed validation: ${firstTry.error}\nReturn a corrected JSON object that satisfies the schema.`;
    this.guard({ ...request, user: retryUser });
    const second = await this.send(request, pre.modelId, pre.effort, schema, retryUser, true);
    const secondTry = this.parse(request, second);
    if (secondTry.ok) return this.result(pre.modelId, second, secondTry.data);
    throw new ContractError(`LLM output for ${request.stageId} (${request.schemaName})`, [secondTry.error]);
  }

  private guard(request: StructuredCallRequest): ReturnType<typeof preflight> {
    const pre = preflight(request, this.vault);
    if (this.piiGate) {
      const opts = this.vault ? { vault: this.vault } : {};
      assertNoPii(request.system, opts);
      assertNoPii(request.user, opts);
    }
    return pre;
  }

  private args(stageId: LlmStageId, modelId: string, effort: string | null, schema: unknown, system: string): string[] {
    const model = this.aliases ? MODELS[getStagePolicy(stageId).modelAlias].alias : modelId;
    return [
      "-p",
      "--model", model,
      "--tools", "",
      "--setting-sources", "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--output-format", "json",
      "--system-prompt", system,
      "--json-schema", JSON.stringify(schema),
      ...(effort ? ["--effort", effort] : []),
    ];
  }

  private async send(request: StructuredCallRequest, modelId: string, effort: string | null, schema: unknown, user: string, schemaRetry: boolean): Promise<CliJson> {
    const { stageId } = request;
    let lastErr = "unknown error";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const run = await this.runner(this.args(stageId, modelId, effort, schema, request.system), user, { cwd: this.workDir, timeoutMs: this.timeoutMs });
        let json: CliJson;
        try {
          json = JSON.parse(run.stdout) as CliJson;
        } catch {
          lastErr = `the CLI exited with code ${run.code} and no JSON${run.stderr ? `: ${run.stderr.slice(0, 200).replace(/\s+/g, " ")}` : ""}`;
          if (attempt < this.maxAttempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        if (json.is_error || (json.subtype && json.subtype !== "success")) {
          const msg = String(json.result ?? json.subtype ?? "error").slice(0, 200).replace(/\s+/g, " ");
          if (/refus/i.test(`${json.terminal_reason ?? ""} ${json.stop_reason ?? ""}`)) throw new LlmRefusalError(stageId);
          lastErr = msg;
          if (attempt < this.maxAttempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        const u = json.usage ?? {};
        this.usageLog.push({ stageId, modelId, costUsd: json.total_cost_usd ?? 0, attempt, schemaRetry, usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadInputTokens: u.cache_read_input_tokens ?? 0, cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0 } });
        return json;
      } catch (err) {
        if (err instanceof LlmRefusalError) throw err;
        lastErr = err instanceof Error ? err.message.slice(0, 200) : "spawn failed";
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new ClaudeCodeError(stageId, "the `claude` CLI was not found on PATH");
        if (attempt < this.maxAttempts) await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw new ClaudeCodeError(stageId, lastErr);
  }

  private parse<S extends z.ZodType>(request: StructuredCallRequest<S>, json: CliJson): { ok: true; data: z.infer<S> } | { ok: false; error: string } {
    let value: unknown = json.structured_output;
    if (value === undefined) {
      try {
        value = JSON.parse(json.result ?? "");
      } catch {
        return { ok: false, error: "output was not valid JSON" };
      }
    }
    const parsed = request.schema.safeParse(value);
    if (parsed.success) return { ok: true, data: parsed.data as z.infer<S> };
    return { ok: false, error: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }

  private result<T>(modelId: string, json: CliJson, data: T): StructuredCallResult<T> {
    const u = json.usage ?? {};
    return {
      data,
      modelId,
      stopReason: "end_turn",
      usedFallback: false,
      usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadInputTokens: u.cache_read_input_tokens ?? 0, cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0 },
    };
  }
}
