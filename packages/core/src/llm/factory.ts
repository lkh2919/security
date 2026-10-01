/**
 * Picks the model backend for the scripts: the Anthropic API (needs `ANTHROPIC_API_KEY`) or Claude Code headless
 * (`--llm claude-code`, runs on the operator's Claude Code login, no API key). The choice is always explicit or
 * key-driven; nothing silently spends a subscription.
 */
import type { PiiVault } from "../contracts/pii-vault";
import { AnthropicLlmClient } from "./anthropic-client";
import { ClaudeCodeLlmClient } from "./claude-code-client";
import type { LlmClient } from "./client";
import type { LlmStageId } from "./models";

export type LlmBackend = "api" | "claude-code";

export interface BackendClient {
  readonly backend: LlmBackend;
  readonly client: LlmClient;
  /** Per-stage usage line for the run log (no prompts, no values). */
  usageLine(stage: LlmStageId): string | null;
  close(): void;
}

/** `flag` is the value of `--llm` (or undefined). Returns null when no backend can be chosen. */
export function resolveBackend(flag: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): LlmBackend | null {
  if (flag === "api" || flag === "claude-code") return flag;
  if (flag !== undefined) throw new Error("--llm must be api or claude-code");
  return env["ANTHROPIC_API_KEY"] ? "api" : null;
}

export function createBackendClient(backend: LlmBackend, opts: { vault?: PiiVault; piiGate?: boolean } = {}): BackendClient {
  if (backend === "api") {
    const client = new AnthropicLlmClient(opts);
    return { backend, client, usageLine: (s) => (client.totals(s).calls ? JSON.stringify(client.totals(s)) : null), close: () => undefined };
  }
  const client = new ClaudeCodeLlmClient(opts);
  return { backend, client, usageLine: (s) => (client.totals(s).calls ? JSON.stringify(client.totals(s)) : null), close: () => client.close() };
}
