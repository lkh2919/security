import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ContractError } from "../src/contracts/common";
import { PiiLeakError, LlmRefusalError, type StructuredCallRequest } from "../src/llm/client";
import { AnthropicLlmClient, LlmTransportError, LlmTruncatedError, SERVER_SIDE_FALLBACK_BETA } from "../src/llm/anthropic-client";
import { PiiResidualError } from "../src/stages/intake/gate";
import { RUN_ID } from "./fixtures";

const Out = z.strictObject({ answer: z.string(), n: z.number() });

function message(text: string, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 0, ...usage },
    ...extra,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function stub(responses: Array<Response | (() => Response)>) {
  const calls: Captured[] = [];
  let i = 0;
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]), body: JSON.parse(String(init?.body)) });
    const next = responses[Math.min(i++, responses.length - 1)];
    return typeof next === "function" ? next() : next.clone();
  }) as unknown as typeof fetch;
  return { fetchStub, calls };
}

function request(stageId: "R2" | "R3" = "R2", user = "masked text"): StructuredCallRequest<typeof Out> {
  return { stageId, system: "static prefix", user, schema: Out, schemaName: "Out", promptVersion: "1.0.0" };
}

function client(responses: Array<Response | (() => Response)>, extra: Partial<ConstructorParameters<typeof AnthropicLlmClient>[0]> = {}) {
  const s = stub(responses);
  const delays: number[] = [];
  const c = new AnthropicLlmClient({ apiKey: "sk-ant-test-secret", fetch: s.fetchStub, sleep: async (ms) => void delays.push(ms), ...extra });
  return { c, delays, ...s };
}

describe("AnthropicLlmClient request shape", () => {
  test("R2 (Haiku): pinned model, structured output, cached prefix, no effort, no sampling params, no fallback", async () => {
    const { c, calls } = client([json(200, message('{"answer":"ok","n":1}'))]);
    const res = await c.callStructured(request("R2"));
    expect(res.data).toEqual({ answer: "ok", n: 1 });
    const body = calls[0].body;
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.properties.answer).toBeDefined();
    expect(body.output_config.effort).toBeUndefined();
    expect(body.system).toEqual([{ type: "text", text: "static prefix", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([{ role: "user", content: "masked text" }]);
    for (const k of ["temperature", "top_p", "top_k", "tool_choice", "tools", "fallbacks"]) expect(body[k]).toBeUndefined();
    expect(calls[0].headers.get("anthropic-beta") ?? "").not.toContain(SERVER_SIDE_FALLBACK_BETA);
    expect(calls[0].headers.get("x-api-key")).toBe("sk-ant-test-secret");
  });

  test("R3 (Sonnet 5.5): explicit low effort and server-side refusal fallback", async () => {
    const { c, calls } = client([json(200, message('{"answer":"ok","n":1}'))]);
    await c.callStructured(request("R3"));
    const body = calls[0].body;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.fallbacks).toBe("default");
    expect(calls[0].headers.get("anthropic-beta")).toContain(SERVER_SIDE_FALLBACK_BETA);
  });

  test("records per-call usage, totals and fallback use", async () => {
    const { c } = client([
      json(200, message('{"answer":"a","n":1}', {}, { iterations: [{ type: "message" }, { type: "fallback_message" }] })),
      json(200, message('{"answer":"b","n":2}', {}, { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0 })),
    ]);
    const first = await c.callStructured(request("R3"));
    await c.callStructured(request("R3"));
    expect(first.usedFallback).toBe(true);
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 60, cacheCreationInputTokens: 0 });
    expect(c.usageLog).toHaveLength(2);
    expect(c.totals("R3")).toEqual({ calls: 2, inputTokens: 150, outputTokens: 25, cacheReadInputTokens: 60, cacheCreationInputTokens: 0 });
    expect(c.totals("R2").calls).toBe(0);
  });
});

describe("AnthropicLlmClient hard gates", () => {
  const vault = { runId: RUN_ID, entries: { PERSON_1: { kind: "person", value: "최수진" } } };

  test("a vault value in system or user throws PiiLeakError before any network call", async () => {
    const { c, calls } = client([json(200, message('{"answer":"ok","n":1}'))], { vault });
    await expect(c.callStructured(request("R2", "안녕하세요 최수진입니다"))).rejects.toBeInstanceOf(PiiLeakError);
    await expect(c.callStructured({ ...request("R2"), system: "최수진" })).rejects.toBeInstanceOf(PiiLeakError);
    expect(calls).toHaveLength(0);
  });

  test("residual PII the masker missed (phone, email, long number) is stopped by the intake gate, even with no vault", async () => {
    const { c, calls } = client([json(200, message('{"answer":"ok","n":1}'))], { piiGate: true });
    for (const leaky of ["전화는 010-2345-6789 입니다", "메일은 someone@example-corp.co.kr 입니다", "계좌 110123456789 입니다"]) {
      await expect(c.callStructured(request("R2", leaky))).rejects.toBeInstanceOf(PiiResidualError);
    }
    await expect(c.callStructured({ ...request("R2"), system: "연락처 02-555-1234" })).rejects.toBeInstanceOf(PiiResidualError);
    expect(calls).toHaveLength(0);
    // Placeholders and clean Korean text pass.
    await c.callStructured(request("R2", "{{PERSON_1}}님이 배송은 택배사에 맡긴다고 했습니다"));
    expect(calls).toHaveLength(1);
  });

  test("the residual gate is off by default (masking is off by default)", async () => {
    const { c, calls } = client([json(200, message('{"answer":"ok","n":1}'))]);
    await c.callStructured(request("R2", "전화는 010-2345-6789 입니다"));
    expect(calls).toHaveLength(1);
  });

  test("the gate error never contains the leaked value", async () => {
    const { c } = client([json(200, message("{}"))], { piiGate: true });
    const err = await c.callStructured(request("R2", "전화는 010-2345-6789 입니다")).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain("2345");
  });

  test("the schema-retry payload is gated too", async () => {
    const { c, calls } = client([json(200, message('{"answer":"ok"}'))]);
    // First call is clean; retry text is built from the same clean user text, so it passes and is sent.
    await expect(c.callStructured(request())).rejects.toBeInstanceOf(ContractError);
    expect(calls).toHaveLength(2);
  });

  test("sampling parameters are rejected at runtime", async () => {
    const { c, calls } = client([json(200, message("{}"))]);
    await expect(c.callStructured({ ...request(), temperature: 0 } as unknown as StructuredCallRequest)).rejects.toThrow(/sampling/);
    expect(calls).toHaveLength(0);
  });

  test("missing API key fails at construction without echoing anything", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new AnthropicLlmClient()).toThrow(/ANTHROPIC_API_KEY is not set/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("the API key never appears in errors", async () => {
    const { c } = client([json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })]);
    const err = await c.callStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect(String((err as Error).message)).not.toContain("sk-ant-test-secret");
  });
});

describe("AnthropicLlmClient failure handling", () => {
  test("429 then 500 then success: retries with exponential backoff", async () => {
    const { c, calls, delays } = client([
      json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
      json(500, { type: "error", error: { type: "api_error", message: "boom" } }),
      json(200, message('{"answer":"ok","n":1}')),
    ]);
    const res = await c.callStructured(request());
    expect(res.data.answer).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
    expect(c.usageLog).toHaveLength(1);
  });

  test("gives up after maxAttempts on persistent 5xx", async () => {
    const { c, calls } = client([json(503, { type: "error", error: { type: "api_error", message: "down" } })], { maxAttempts: 3 });
    const err = await c.callStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmTransportError);
    expect((err as LlmTransportError).status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  test("400 is not retried", async () => {
    const { c, calls } = client([json(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } })]);
    await expect(c.callStructured(request())).rejects.toBeInstanceOf(LlmTransportError);
    expect(calls).toHaveLength(1);
  });

  test("refusal stop reason surfaces as LlmRefusalError (no retry)", async () => {
    const { c, calls } = client([json(200, message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } }))]);
    await expect(c.callStructured(request())).rejects.toBeInstanceOf(LlmRefusalError);
    expect(calls).toHaveLength(1);
  });

  test("max_tokens stop reason surfaces as LlmTruncatedError", async () => {
    const { c } = client([json(200, message('{"answer":', { stop_reason: "max_tokens" }))]);
    await expect(c.callStructured(request())).rejects.toBeInstanceOf(LlmTruncatedError);
  });

  test("schema-invalid output gets exactly one retry carrying the validator error", async () => {
    const { c, calls } = client([json(200, message('{"answer":"ok"}')), json(200, message('{"answer":"ok","n":2}'))]);
    const res = await c.callStructured(request());
    expect(res.data.n).toBe(2);
    expect(calls).toHaveLength(2);
    expect(String(calls[1].body.messages[0].content)).toContain("failed validation");
    expect(String(calls[1].body.messages[0].content)).toContain("n:");
    expect(c.usageLog.map((r) => r.schemaRetry)).toEqual([false, true]);
  });

  test("two invalid outputs raise ContractError", async () => {
    const { c, calls } = client([json(200, message("not json")), json(200, message('{"answer":1}'))]);
    await expect(c.callStructured(request())).rejects.toBeInstanceOf(ContractError);
    expect(calls).toHaveLength(2);
  });
});
