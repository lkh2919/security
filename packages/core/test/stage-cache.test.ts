import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { StageCache, computeCacheKey, type StageCacheKeyParts } from "../src/pipeline";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pa-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const parts: StageCacheKeyParts = {
  stageId: "R2",
  input: { segments: ["T0001"], slots: { b: 1, a: 2 } },
  promptVersion: "1.0.0",
  modelId: "claude-haiku-4-5",
  versions: { "privacy-2026.04": "2026.04", manifest: "0.1.0" },
};
const OutSchema = z.object({ n: z.number() });

describe("computeCacheKey", () => {
  test("is stable across input key order", () => {
    const reordered = { ...parts, input: { slots: { a: 2, b: 1 }, segments: ["T0001"] } };
    expect(computeCacheKey(reordered)).toBe(computeCacheKey(parts));
    expect(computeCacheKey(parts)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["input", { ...parts, input: { segments: ["T0002"] } }],
    ["prompt version", { ...parts, promptVersion: "1.0.1" }],
    ["model id", { ...parts, modelId: "claude-sonnet-5-5" }],
    ["rule pack version", { ...parts, versions: { ...parts.versions, "privacy-2026.04": "2026.05" } }],
    ["stage id", { ...parts, stageId: "R3" }],
  ])("changes when the %s changes", (_name, changed) => {
    expect(computeCacheKey(changed as StageCacheKeyParts)).not.toBe(computeCacheKey(parts));
  });

  test("rejects unsafe stage ids used as directory names", () => {
    expect(() => computeCacheKey({ ...parts, stageId: "../evil" })).toThrow();
  });
});

describe("StageCache", () => {
  test("miss, then hit after put; hit skips compute", async () => {
    const cache = new StageCache({ dir });
    expect((await cache.get(parts)).hit).toBe(false);

    let calls = 0;
    const compute = () => {
      calls++;
      return { n: 42 };
    };
    const first = await cache.getOrCompute<typeof OutSchema>(parts, compute, { schema: OutSchema });
    const second = await cache.getOrCompute<typeof OutSchema>(parts, compute, { schema: OutSchema });
    expect(first).toMatchObject({ hit: false, output: { n: 42 } });
    expect(second).toMatchObject({ hit: true, output: { n: 42 } });
    expect(second.key).toBe(first.key);
    expect(calls).toBe(1);
  });

  test("changed prompt version or KB stamp is a miss and recomputes", async () => {
    const cache = new StageCache({ dir });
    let calls = 0;
    const compute = () => ({ n: ++calls });
    await cache.getOrCompute(parts, compute);
    await cache.getOrCompute({ ...parts, promptVersion: "2.0.0" }, compute);
    await cache.getOrCompute({ ...parts, versions: { ...parts.versions, manifest: "0.2.0" } }, compute);
    expect(calls).toBe(3);
    expect((await cache.get(parts)).hit).toBe(true);
  });

  test("expired entries are misses (24 h freshness cache)", async () => {
    let now = new Date("2026-09-29T00:00:00Z");
    const cache = new StageCache({ dir, now: () => now });
    await cache.put(parts, { n: 1 });
    now = new Date("2026-09-29T12:00:00Z");
    expect((await cache.get(parts, { maxAgeMs: 24 * 3600_000 })).hit).toBe(true);
    now = new Date("2026-09-30T00:00:01Z");
    expect((await cache.get(parts, { maxAgeMs: 24 * 3600_000 })).hit).toBe(false);
  });

  test("schema-invalid or corrupt entries are misses and get replaced", async () => {
    const cache = new StageCache({ dir });
    await cache.put(parts, { n: "not a number" });
    expect((await cache.get(parts, { schema: OutSchema })).hit).toBe(false);

    await writeFile(cache.entryPath(parts), "{ not json", "utf8");
    expect((await cache.get(parts)).hit).toBe(false);

    const result = await cache.getOrCompute<typeof OutSchema>(parts, () => ({ n: 7 }), { schema: OutSchema });
    expect(result.hit).toBe(false);
    expect((await cache.get(parts, { schema: OutSchema })).hit).toBe(true);
  });

  test("failed compute stores nothing; compute output is validated before storing", async () => {
    const cache = new StageCache({ dir });
    await expect(cache.getOrCompute(parts, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await cache.get(parts)).hit).toBe(false);
    await expect(cache.getOrCompute<typeof OutSchema>(parts, () => ({ n: "x" }) as never, { schema: OutSchema })).rejects.toThrow();
    expect((await cache.get(parts)).hit).toBe(false);
  });

  test("writes leave no temp files behind", async () => {
    const cache = new StageCache({ dir });
    await Promise.all(Array.from({ length: 8 }, (_, i) => cache.put({ ...parts, input: { i } }, { n: i })));
    const files = await readdir(join(dir, "R2"));
    expect(files).toHaveLength(8);
    expect(files.every((f) => f.endsWith(".json") && !f.endsWith(".tmp"))).toBe(true);
  });
});
