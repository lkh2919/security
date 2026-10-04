/**
 * runResumableStage: one step of a chain bound to the RunStore. A step whose record is `done` and whose artifact exists is not run
 * again: its artifact is read back (resume after a failure later in the chain). A `running` (crash) or `failed` step runs again.
 * A failure marks the stage `failed` (message only) and rethrows, so the caller's chain stops and a rerun continues at that step.
 */
import type { z } from "zod";
import type { PipelineStage } from "../contracts/run-state";
import type { RunStore } from "./run-store";

export interface RunResumableArgs<S extends z.ZodType> {
  readonly stage: PipelineStage;
  readonly schema: S;
  readonly compute: () => Promise<z.infer<S>> | z.infer<S>;
  readonly variant?: string;
  readonly now?: () => Date;
}

export interface RunResumableResult<T> {
  readonly output: T;
  /** True when the artifact of an earlier invocation was reused. */
  readonly resumed: boolean;
  readonly artifact: string;
}

export async function runResumableStage<S extends z.ZodType>(store: RunStore, args: RunResumableArgs<S>): Promise<RunResumableResult<z.infer<S>>> {
  const now = args.now ?? (() => new Date());
  const record = (await store.readState()).stages[args.stage];
  const opts = { schema: args.schema, ...(args.variant ? { variant: args.variant } : {}) };
  if (record?.status === "done" && (await store.hasArtifact(args.stage, args.variant))) {
    return { output: await store.readArtifact(args.stage, opts), resumed: true, artifact: store.artifactName(args.stage, args.variant) };
  }
  await store.markStage(args.stage, { status: "running", startedAt: now().toISOString(), error: undefined });
  try {
    const output = await args.compute();
    const artifact = await store.writeArtifact(args.stage, output, opts);
    await store.markStage(args.stage, { status: "done", artifact, finishedAt: now().toISOString() });
    return { output: await store.readArtifact(args.stage, opts), resumed: false, artifact };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.markStage(args.stage, { status: "failed", error: message.slice(0, 500), finishedAt: now().toISOString() });
    throw err;
  }
}
