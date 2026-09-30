import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { PiiVaultSchema } from "../src/contracts";
import {
  FORBIDDEN_SAMPLING_PARAMS,
  LLM_STAGE_IDS,
  LlmRefusalError,
  MODELS,
  MockLlmClient,
  PiiLeakError,
  STAGE_MODEL_POLICIES,
  assertNoSamplingParams,
  getStagePolicy,
  type StructuredCallRequest,
} from "../src/llm";
import { RUN_ID } from "./fixtures";

const Out = z.object({ ok: z.boolean() });
const request = (over: Partial<StructuredCallRequest<typeof Out>> = {}): StructuredCallRequest<typeof Out> => ({
  stageId: "R2",
  system: "You extract facts.",
  user: "T0001: hello",
  schema: Out,
  schemaName: "Out",
  promptVersion: "1.0.0",
  ...over,
});

describe("model registry", () => {
  test("model IDs are pinned to the design values", () => {
    expect(MODELS.haiku.id).toBe("claude-haiku-4-5");
    expect(MODELS.sonnet.id).toBe("claude-sonnet-5-5");
    expect(MODELS.opus.id).toBe("claude-opus-5-5");
  });

  test("every stage has a policy with explicit effort matching model capability and structured output", () => {
    expect(Object.keys(STAGE_MODEL_POLICIES).sort()).toEqual([...LLM_STAGE_IDS].sort());
    for (const id of LLM_STAGE_IDS) {
      const p = getStagePolicy(id);
      expect(p.modelId).toBe(MODELS[p.modelAlias].id);
      expect(p.structuredOutput).toBe(true);
      expect(p.refusalFallback).toBe("default");
      expect(p.effort === null).toBe(!MODELS[p.modelAlias].supportsEffort);
    }
  });

  test("tiers and budgets follow the R3 table", () => {
    const summary = Object.fromEntries(LLM_STAGE_IDS.map((id) => {
      const p = getStagePolicy(id);
      return [id, [p.modelAlias, p.effort, p.maxInputTokens, p.maxOutputTokens]];
    }));
    expect(summary).toEqual({
      R2: ["haiku", null, 30_000, 6_000],
      R3: ["sonnet", "low", 8_000, 2_000],
      "R4-fallback": ["haiku", null, 3_000, 500],
      R5P: ["sonnet", "medium", 6_000, 2_000],
      R5T: ["sonnet", "medium", 6_000, 2_000],
      R6: ["haiku", null, 4_000, 500],
      R7: ["opus", "high", 60_000, 6_000],
    });
  });

  test("auditor tier differs from drafter tier (isolation by model tier)", () => {
    expect(getStagePolicy("R7").modelId).not.toBe(getStagePolicy("R5P").modelId);
  });
});

describe("MockLlmClient", () => {
  test("returns schema-validated fixtures and records calls with resolved model and effort", async () => {
    const client = new MockLlmClient({ fixtures: { R7: { ok: true } } });
    const res = await client.callStructured(request({ stageId: "R7" }));
    expect(res.data).toEqual({ ok: true });
    expect(res.modelId).toBe("claude-opus-5-5");
    expect(res.usedFallback).toBe(false);
    expect(client.calls[0]).toMatchObject({ stageId: "R7", effort: "high", fallback: "default", promptVersion: "1.0.0" });
  });

  test("function fixtures see the request; missing fixtures and invalid fixtures throw", async () => {
    const client = new MockLlmClient({ fixtures: { R2: (r: StructuredCallRequest) => ({ ok: r.user.length > 0 }), R6: { ok: "nope" } } });
    expect((await client.callStructured(request())).data).toEqual({ ok: true });
    await expect(client.callStructured(request({ stageId: "R3" }))).rejects.toThrow("no fixture");
    await expect(client.callStructured(request({ stageId: "R6" }))).rejects.toThrow("CONTRACT_ERROR");
  });

  test("rejects sampling parameters at runtime, even when smuggled past the type system", async () => {
    const client = new MockLlmClient({ fixtures: { R2: { ok: true } } });
    for (const key of FORBIDDEN_SAMPLING_PARAMS) {
      const smuggled = { ...request(), [key]: 0.2 } as unknown as StructuredCallRequest<typeof Out>;
      await expect(client.callStructured(smuggled)).rejects.toThrow("sampling parameter");
    }
    expect(() => assertNoSamplingParams({ temperature: 0 })).toThrow();
    expect(() => assertNoSamplingParams({ system: "x" })).not.toThrow();
  });

  test("effort override is refused for models without effort control, accepted otherwise", async () => {
    const client = new MockLlmClient({ fixtures: { R2: { ok: true }, R3: { ok: true } } });
    await expect(client.callStructured(request({ stageId: "R2", effort: "high" }))).rejects.toThrow("no effort control");
    await client.callStructured(request({ stageId: "R3", effort: "medium" }));
    expect(client.calls.at(-1)?.effort).toBe("medium");
  });

  test("blocks payloads containing PiiVault values (masking hard gate)", async () => {
    const vault = PiiVaultSchema.parse({ runId: RUN_ID, entries: { PERSON_1: { kind: "person", value: "Hong Gildong" } } });
    const client = new MockLlmClient({ fixtures: { R2: { ok: true } }, vault });
    await client.callStructured(request({ user: "T0001: {{PERSON_1}} said yes" }));
    await expect(client.callStructured(request({ user: "T0001: Hong Gildong said yes" }))).rejects.toThrow(PiiLeakError);
    expect(client.callCount()).toBe(1);
  });

  test("refusal: server fallback rescues when enabled, otherwise LlmRefusalError", async () => {
    const rescued = new MockLlmClient({ fixtures: { R5P: { ok: true } }, refuse: { R5P: { fallbackRescues: true } } });
    expect((await rescued.callStructured(request({ stageId: "R5P" }))).usedFallback).toBe(true);
    await expect(rescued.callStructured(request({ stageId: "R5P", fallback: "none" }))).rejects.toThrow(LlmRefusalError);
    const hopeless = new MockLlmClient({ fixtures: { R5P: { ok: true } }, refuse: { R5P: { fallbackRescues: false } } });
    await expect(hopeless.callStructured(request({ stageId: "R5P" }))).rejects.toThrow(LlmRefusalError);
  });
});
