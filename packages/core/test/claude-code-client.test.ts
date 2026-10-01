import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ContractError } from "../src/contracts/common";
import { PiiLeakError } from "../src/llm/client";
import { ClaudeCodeError, ClaudeCodeLlmClient, MAX_SYSTEM_PROMPT_BYTES, childEnv, createBackendClient, resolveBackend, type CliRunner } from "../src/llm";

const Out = z.strictObject({ answer: z.string(), n: z.number().int() });
const request = (user = "masked text", stageId: "R2" | "R5P" | "R7" = "R2") => ({ stageId, system: "static prefix", user, schema: Out, schemaName: "Out", promptVersion: "1.0.0" }) as const;

const ok = (structured: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ is_error: false, subtype: "success", structured_output: structured, result: JSON.stringify(structured), total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }, ...extra });

function client(replies: (string | Error | { stdout: string; code: number })[], extra: Partial<ConstructorParameters<typeof ClaudeCodeLlmClient>[0]> = {}) {
  const calls: { args: readonly string[]; stdin: string; cwd: string }[] = [];
  const runner: CliRunner = async (args, stdin, opts) => {
    calls.push({ args, stdin, cwd: opts.cwd });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return typeof r === "string" ? { code: 0, stdout: r, stderr: "" } : { code: r.code, stdout: r.stdout, stderr: "boom" };
  };
  const delays: number[] = [];
  const c = new ClaudeCodeLlmClient({ runner, sleep: async (ms) => void delays.push(ms), ...extra });
  return { c, calls, delays };
}
const flag = (args: readonly string[], name: string): string | undefined => args[args.indexOf(name) + 1];

describe("ClaudeCodeLlmClient", () => {
  test("runs one isolated headless call: pinned model, no tools, no settings, schema, stdin carries only the user turn", async () => {
    const { c, calls } = client([ok({ answer: "ok", n: 1 })]);
    const res = await c.callStructured(request("hello user turn"));
    c.close();
    expect(res.data).toEqual({ answer: "ok", n: 1 });
    expect(res.modelId).toBe("claude-haiku-4-5");
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 7 });
    const { args, stdin, cwd } = calls[0]!;
    expect(args[0]).toBe("-p");
    expect(flag(args, "--model")).toBe("claude-haiku-4-5");
    expect(flag(args, "--tools")).toBe("");
    expect(flag(args, "--setting-sources")).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    expect(flag(args, "--system-prompt")).toBe("static prefix");
    expect(JSON.parse(flag(args, "--json-schema")!).properties.answer).toBeDefined();
    expect(args).not.toContain("--effort"); // Haiku has no effort control
    expect(stdin).toBe("hello user turn");
    expect(args.join(" ")).not.toContain("hello user turn"); // never in argv / the process list
    expect(cwd).toContain("pa-claude-code-");
  });

  test("Sonnet and Opus stages pass their pinned model and explicit effort", async () => {
    const { c, calls } = client([ok({ answer: "a", n: 2 })]);
    await c.callStructured(request("u", "R5P"));
    await c.callStructured(request("u", "R7"));
    c.close();
    expect(calls.map((x) => flag(x.args, "--model"))).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(calls.map((x) => flag(x.args, "--effort"))).toEqual(["medium", "high"]);
  });

  test("alias mode passes haiku|sonnet|opus instead of the pinned ids", async () => {
    const { c, calls } = client([ok({ answer: "a", n: 1 })], { models: "alias" });
    await c.callStructured(request("u", "R7"));
    c.close();
    expect(flag(calls[0]!.args, "--model")).toBe("opus");
  });

  test("falls back to the result text when structured_output is absent", async () => {
    const { c } = client([JSON.stringify({ is_error: false, subtype: "success", result: '{"answer":"x","n":3}', usage: {} })]);
    expect((await c.callStructured(request())).data).toEqual({ answer: "x", n: 3 });
    c.close();
  });

  test("schema-invalid output gets exactly one retry that carries the validator error; then a ContractError", async () => {
    const bad = ok({ answer: 5, n: "x" });
    const { c, calls } = client([bad, ok({ answer: "fixed", n: 1 })]);
    expect((await c.callStructured(request())).data.answer).toBe("fixed");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.stdin).toContain("failed validation");
    const again = client([bad, bad]);
    await expect(again.c.callStructured(request())).rejects.toBeInstanceOf(ContractError);
    expect(again.calls).toHaveLength(2);
    c.close();
    again.c.close();
  });

  test("transport errors are retried with backoff, then reported without prompt text", async () => {
    const { c, calls, delays } = client([{ stdout: "", code: 1 }, { stdout: "not json", code: 0 }, ok({ answer: "late", n: 1 })]);
    expect((await c.callStructured(request("SECRET-USER-TEXT"))).data.answer).toBe("late");
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([2000, 4000]);
    const dead = client([{ stdout: "", code: 1 }], { maxAttempts: 2 });
    const err = await dead.c.callStructured(request("SECRET-USER-TEXT")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeCodeError);
    expect(String((err as Error).message)).not.toContain("SECRET-USER-TEXT");
    c.close();
    dead.c.close();
  });

  test("an is_error reply is a failure; a missing CLI says so", async () => {
    const e = client([JSON.stringify({ is_error: true, subtype: "error_during_execution", result: "rate limited" })], { maxAttempts: 1 });
    await expect(e.c.callStructured(request())).rejects.toThrow(/rate limited/);
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const missing = client([enoent]);
    await expect(missing.c.callStructured(request())).rejects.toThrow(/not found on PATH/);
    e.c.close();
    missing.c.close();
  });

  test("the vault scan runs before the process starts, and the residual gate only when enabled", async () => {
    const vault = { runId: "20260929-101500-a1b2c3", entries: { PHONE_1: { kind: "PHONE", value: "010-2345-6789" } } };
    const { c, calls } = client([ok({ answer: "a", n: 1 })], { vault });
    await expect(c.callStructured(request("전화 010-2345-6789"))).rejects.toBeInstanceOf(PiiLeakError);
    expect(calls).toHaveLength(0);
    const gated = client([ok({ answer: "a", n: 1 })], { piiGate: true });
    await expect(gated.c.callStructured(request("전화는 010-9999-8888 입니다"))).rejects.toThrow();
    expect(gated.calls).toHaveLength(0);
    const plain = client([ok({ answer: "a", n: 1 })]);
    await plain.c.callStructured(request("전화는 010-9999-8888 입니다"));
    expect(plain.calls).toHaveLength(1);
    c.close();
    gated.c.close();
    plain.c.close();
  });

  test("an oversized system prompt is refused instead of truncated", async () => {
    const { c, calls } = client([ok({ answer: "a", n: 1 })]);
    await expect(c.callStructured({ ...request(), system: "가".repeat(MAX_SYSTEM_PROMPT_BYTES / 3 + 10) })).rejects.toThrow(/larger than/);
    expect(calls).toHaveLength(0);
    c.close();
  });

  test("usage and cost are totalled per stage", async () => {
    const { c } = client([ok({ answer: "a", n: 1 })]);
    await c.callStructured(request("u", "R2"));
    await c.callStructured(request("u", "R2"));
    await c.callStructured(request("u", "R7"));
    expect(c.totals("R2")).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 40, costUsd: 0.004 });
    expect(c.totals().calls).toBe(3);
    c.close();
  });
});

describe("backend selection", () => {
  test("explicit flag wins; a key alone selects the API; nothing selects nothing", () => {
    expect(resolveBackend("claude-code", {})).toBe("claude-code");
    expect(resolveBackend("api", {})).toBe("api");
    expect(resolveBackend(undefined, { ANTHROPIC_API_KEY: "x" })).toBe("api");
    expect(resolveBackend(undefined, {})).toBeNull();
    expect(() => resolveBackend("openai", {})).toThrow(/--llm/);
  });
  test("claude-code backend builds without a key and cleans up", () => {
    const b = createBackendClient("claude-code");
    expect(b.backend).toBe("claude-code");
    expect(b.usageLine("R2")).toBeNull();
    b.close();
  });
});

describe("childEnv", () => {
  test("drops credentials the claude child does not need and keeps its login and proxy settings", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/root", HTTPS_PROXY: "http://p", CLAUDE_CODE_OAUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "u", LAW_GO_KR_OC: "k", ANTHROPIC_API_KEY: "k", GH_TOKEN: "k", AWS_SECRET_ACCESS_KEY: "k", OPENAI_API_KEY: "k", DB_PASSWORD: "k" });
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "HOME", "HTTPS_PROXY", "PATH"]);
  });
});
