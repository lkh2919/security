import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PiiVaultSchema } from "../src/contracts";
import { RunStore, RunStoreError, STATE_FILE, StageCache, atomicWriteFile, hashJson, runCachedStage } from "../src/pipeline";
import { RUN_ID, stamps } from "./fixtures";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pa-runs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-09-29T10:15:00.000Z");
const input = { config: { jurisdiction: "kr" }, transcriptRef: "sha256:abc" };

async function newStore(runId = RUN_ID) {
  return RunStore.create({ runsRoot: root, runId, input, stamps, documents: ["privacy", "terms"], now: fixedNow });
}

describe("atomicWriteFile", () => {
  test("creates parent directories, overwrites, and leaves no temp file", async () => {
    const target = join(root, "a", "b", "file.json");
    await atomicWriteFile(target, "one");
    await atomicWriteFile(target, "two");
    expect(await readFile(target, "utf8")).toBe("two");
    expect(await readdir(join(root, "a", "b"))).toEqual(["file.json"]);
  });

  test("a failed write leaves the previous content intact", async () => {
    const target = join(root, "keep.json");
    await atomicWriteFile(target, "original");
    // A directory at the target path makes rename fail after the temp file was written.
    const blocked = join(root, "blocked");
    await mkdir(join(blocked, "child"), { recursive: true });
    await expect(atomicWriteFile(blocked, "x")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("original");
    expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("RunStore", () => {
  test("create writes input snapshot and initial state with stamps", async () => {
    const store = await newStore();
    expect(store.dir).toBe(join(root, RUN_ID));
    expect(await store.readInput()).toEqual(input);
    const state = await store.readState();
    expect(state).toMatchObject({ runId: RUN_ID, status: "running", stamps, inputHash: hashJson(input), interviewRound: 0 });
    expect((await readdir(store.dir)).sort()).toEqual(["00-input.json", "run-state.json"]);
  });

  test("refuses to overwrite an existing run and rejects path-traversal run ids", async () => {
    await newStore();
    await expect(newStore()).rejects.toThrow(RunStoreError);
    await expect(newStore("../escape")).rejects.toThrow();
    await expect(newStore("a/b")).rejects.toThrow();
  });

  test("open loads an existing run and refuses an incomplete directory", async () => {
    await newStore();
    const reopened = await RunStore.open(root, RUN_ID);
    expect((await reopened.readState()).runId).toBe(RUN_ID);
    await mkdir(join(root, "half-made-run"));
    await expect(RunStore.open(root, "half-made-run")).rejects.toThrow(RunStoreError);
  });

  test("artifacts use NN-stage names, validate against the schema, and round-trip", async () => {
    const store = await newStore();
    const Schema = z.strictObject({ n: z.number() });
    expect(store.artifactName("extract")).toBe("03-extract.json");
    expect(store.artifactName("audit", "privacy.i2")).toBe("10-audit.privacy.i2.json");
    expect(() => store.artifactName("audit", "../x")).toThrow(RunStoreError);

    const name = await store.writeArtifact("extract", { n: 1 }, { schema: Schema });
    expect(name).toBe("03-extract.json");
    expect(await store.readArtifact("extract", { schema: Schema })).toEqual({ n: 1 });
    expect(await store.hasArtifact("extract")).toBe(true);
    expect(await store.hasArtifact("draft")).toBe(false);

    // Invalid data is rejected before anything is written.
    await expect(store.writeArtifact("draft", { n: "x" }, { schema: Schema })).rejects.toThrow("CONTRACT_ERROR");
    expect(await store.hasArtifact("draft")).toBe(false);
  });

  test("state updates are validated; an invalid update leaves the file untouched", async () => {
    const store = await newStore();
    const before = await readFile(join(store.dir, STATE_FILE), "utf8");
    await expect(
      store.updateState((s) => {
        s.status = "awaiting_answers"; // invalid: current stage is not interview
      }),
    ).rejects.toThrow("CONTRACT_ERROR");
    expect(await readFile(join(store.dir, STATE_FILE), "utf8")).toBe(before);
    // The queue stays usable after a failure.
    const ok = await store.updateState((s) => {
      s.interviewRound = 1;
    });
    expect(ok.interviewRound).toBe(1);
  });

  test("concurrent state updates do not lose writes", async () => {
    const store = await newStore();
    await Promise.all(
      (["intake", "mask", "extract", "coverage", "freshness"] as const).map((stage) => store.markStage(stage, { status: "done" })),
    );
    const state = await store.readState();
    expect(Object.keys(state.stages).sort()).toEqual(["coverage", "extract", "freshness", "intake", "mask"]);
  });

  test("vault is stored under the run dir and validated", async () => {
    const store = await newStore();
    const vault = PiiVaultSchema.parse({ runId: RUN_ID, entries: { PERSON_1: { kind: "person", value: "Hong Gildong" } } });
    await store.writeLocalVault(vault);
    expect(await store.readLocalVault()).toEqual(vault);
    await expect(store.writeLocalVault({ runId: RUN_ID, entries: { bad: { kind: "x", value: "y" } } } as never)).rejects.toThrow("CONTRACT_ERROR");
  });
});

describe("runCachedStage", () => {
  test("second run with identical inputs hits the cache, skips compute, and records it in RunState", async () => {
    const cache = new StageCache({ dir: join(root, ".cache"), now: fixedNow });
    const Schema = z.object({ slots: z.array(z.string()) });
    const parts = { stageId: "R2", input: { seg: ["T0001"] }, promptVersion: "1.0.0", modelId: "claude-haiku-4-5", versions: { manifest: "0.1.0" } };
    let computeCalls = 0;
    const compute = () => {
      computeCalls++;
      return { slots: ["gate.membership"] };
    };

    const run1 = await newStore("run-one-0001");
    const r1 = await runCachedStage({ store: run1, cache, now: fixedNow }, { stage: "extract", parts, schema: Schema, compute });
    const run2 = await newStore("run-two-0002");
    const r2 = await runCachedStage({ store: run2, cache, now: fixedNow }, { stage: "extract", parts, schema: Schema, compute });

    expect(computeCalls).toBe(1);
    expect(r1.cacheHit).toBe(false);
    expect(r2.cacheHit).toBe(true);
    expect(r2.output).toEqual(r1.output);
    expect(await readFile(run2.path(r2.artifact), "utf8")).toBe(await readFile(run1.path(r1.artifact), "utf8"));
    expect((await run2.readState()).stages.extract).toMatchObject({ status: "done", cacheHit: true, cacheKey: r2.cacheKey, artifact: "03-extract.json" });
  });

  test("a failing stage is marked failed without payload details and rethrows", async () => {
    const cache = new StageCache({ dir: join(root, ".cache") });
    const store = await newStore();
    const parts = { stageId: "R2", input: {}, promptVersion: "1.0.0", modelId: null, versions: {} };
    await expect(
      runCachedStage({ store, cache }, { stage: "extract", parts, schema: z.object({}), compute: () => Promise.reject(new Error("api down")) }),
    ).rejects.toThrow("api down");
    const record = (await store.readState()).stages.extract;
    expect(record).toMatchObject({ status: "failed", error: "api down" });
    expect(await store.hasArtifact("extract")).toBe(false);
  });

  test("garbage in the state dir does not affect open (only run-state.json decides)", async () => {
    const store = await newStore();
    await writeFile(join(store.dir, "notes.txt"), "x", "utf8");
    expect((await RunStore.open(root, RUN_ID)).runId).toBe(RUN_ID);
  });
});
