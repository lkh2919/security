/**
 * runCachedStage: binds a stage to the RunStore and StageCache.
 * A cache hit skips `compute`, still writes the artifact into the run directory, and records the
 * hit in RunState. A failure marks the stage `failed` (message only, no payload) and rethrows.
 */
import type { z } from "zod";
import type { PipelineStage } from "../contracts/run-state";
import { StageCache, type StageCacheKeyParts } from "./stage-cache";
import type { RunStore } from "./run-store";

export interface RunCachedStageArgs<S extends z.ZodType> {
  readonly stage: PipelineStage;
  /** Distinguishes repeated stages (round, iteration) in the artifact file name. */
  readonly variant?: string;
  readonly parts: StageCacheKeyParts;
  readonly schema: S;
  readonly compute: () => Promise<z.infer<S>> | z.infer<S>;
  readonly maxAgeMs?: number;
}

export interface RunCachedStageResult<T> {
  readonly output: T;
  readonly cacheHit: boolean;
  readonly cacheKey: string;
  readonly artifact: string;
}

export async function runCachedStage<S extends z.ZodType>(
  deps: { store: RunStore; cache: StageCache; now?: () => Date },
  args: RunCachedStageArgs<S>,
): Promise<RunCachedStageResult<z.infer<S>>> {
  const now = deps.now ?? (() => new Date());
  await deps.store.markStage(args.stage, { status: "running", startedAt: now().toISOString(), error: undefined });
  try {
    const { output, hit, key } = await deps.cache.getOrCompute<S>(args.parts, args.compute, { schema: args.schema, maxAgeMs: args.maxAgeMs });
    const artifact = await deps.store.writeArtifact(args.stage, output, { variant: args.variant, schema: args.schema });
    await deps.store.markStage(args.stage, { status: "done", artifact, cacheKey: key, cacheHit: hit, finishedAt: now().toISOString() });
    return { output, cacheHit: hit, cacheKey: key, artifact };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.store.markStage(args.stage, { status: "failed", error: message.slice(0, 500), finishedAt: now().toISOString() });
    throw err;
  }
}
