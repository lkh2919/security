/**
 * RunStore: on-disk layout of one run (design R2 tree, R7 handoffs).
 *
 *   <runsRoot>/<runId>/
 *     00-input.json          input snapshot (config and references; never raw transcript or PII)
 *     NN-<stage>[.<variant>].json   one typed artifact per stage, NN from PIPELINE_STAGES order
 *     run-state.json         RunState with version stamps (written last on create, updated atomically)
 *     pii-vault.local.json   PiiVault; local only, never sent to an LLM
 *
 * All writes are atomic (temp file + rename). `run-state.json` is written last on `create`, so a
 * directory without it is an incomplete run that `open` refuses. Paths use `path.join` only.
 */
import { mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { parseContract, RunIdSchema, type DocType } from "../contracts/common";
import { PiiVaultSchema, type PiiVault } from "../contracts/pii-vault";
import type { VersionStamps } from "../contracts/manifest";
import { RunStateSchema, stageOrdinal, type PipelineStage, type RunState, type StageRecord } from "../contracts/run-state";
import { atomicWriteFile } from "./fs-atomic";
import { canonicalJsonPretty, hashJson } from "./canonical";

export const INPUT_FILE = "00-input.json";
export const STATE_FILE = "run-state.json";
export const VAULT_FILE = "pii-vault.local.json";

const SAFE_VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class RunStoreError extends Error {}

export interface CreateRunOptions {
  readonly runsRoot: string;
  /** Explicit run ID; generated when omitted. */
  readonly runId?: string;
  /** Input snapshot. Must not contain raw PII: store references and hashes of raw inputs. */
  readonly input: unknown;
  readonly stamps: VersionStamps;
  readonly documents: readonly DocType[];
  readonly now?: () => Date;
}

export interface ArtifactOptions<S extends z.ZodType> {
  /** Distinguishes repeated stages, e.g. `r2`, `privacy.i2`. */
  readonly variant?: string;
  readonly schema?: S;
}

/** `20260929-101500-a1b2c3` style ID: sortable by time, unique enough for local runs. */
export function generateRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  return `${iso}-${randomBytes(3).toString("hex")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class RunStore {
  /** Serializes state updates within this process so read-modify-write cycles never interleave. */
  private stateQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly runsRoot: string,
    readonly runId: string,
    private readonly now: () => Date,
  ) {}

  get dir(): string {
    return join(this.runsRoot, this.runId);
  }

  path(...segments: string[]): string {
    return join(this.dir, ...segments);
  }

  static async create(options: CreateRunOptions): Promise<RunStore> {
    const now = options.now ?? (() => new Date());
    const runId = parseContract("runId", RunIdSchema, options.runId ?? generateRunId(now()));
    const store = new RunStore(options.runsRoot, runId, now);

    await mkdir(options.runsRoot, { recursive: true });
    try {
      // Non-recursive: fails with EEXIST if the run already exists, so runs are never overwritten.
      await mkdir(store.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new RunStoreError(`run already exists: ${runId}`);
      throw err;
    }

    await atomicWriteFile(store.path(INPUT_FILE), canonicalJsonPretty(options.input));
    const stamp = now().toISOString();
    const state: RunState = parseContract("RunState", RunStateSchema, {
      runId,
      schemaVersion: 1,
      status: "running",
      currentStage: null,
      createdAt: stamp,
      updatedAt: stamp,
      interviewRound: 0,
      auditIteration: { privacy: 0, terms: 0 },
      documents: [...options.documents],
      stages: {},
      stamps: options.stamps,
      inputHash: hashJson(options.input),
    });
    await atomicWriteFile(store.path(STATE_FILE), canonicalJsonPretty(state));
    return store;
  }

  static async open(runsRoot: string, runId: string, now: () => Date = () => new Date()): Promise<RunStore> {
    const id = parseContract("runId", RunIdSchema, runId);
    const store = new RunStore(runsRoot, id, now);
    if (!(await exists(store.path(STATE_FILE)))) throw new RunStoreError(`run not found or incomplete: ${id}`);
    await store.readState();
    return store;
  }

  // --- Input snapshot ------------------------------------------------------------------------

  async readInput(): Promise<unknown> {
    return JSON.parse(await readFile(this.path(INPUT_FILE), "utf8"));
  }

  // --- Stage artifacts -----------------------------------------------------------------------

  artifactName(stage: PipelineStage, variant?: string): string {
    if (variant !== undefined && !SAFE_VARIANT.test(variant)) throw new RunStoreError(`invalid artifact variant: ${variant}`);
    const ordinal = String(stageOrdinal(stage)).padStart(2, "0");
    return variant ? `${ordinal}-${stage}.${variant}.json` : `${ordinal}-${stage}.json`;
  }

  async hasArtifact(stage: PipelineStage, variant?: string): Promise<boolean> {
    return exists(this.path(this.artifactName(stage, variant)));
  }

  /** Validates (when a schema is given) then writes the artifact atomically. Returns its file name. */
  async writeArtifact<S extends z.ZodType>(stage: PipelineStage, data: unknown, options: ArtifactOptions<S> = {}): Promise<string> {
    const name = this.artifactName(stage, options.variant);
    const value = options.schema ? parseContract(name, options.schema, data) : data;
    await atomicWriteFile(this.path(name), canonicalJsonPretty(value));
    return name;
  }

  async readArtifact<S extends z.ZodType>(stage: PipelineStage, options: ArtifactOptions<S> = {}): Promise<z.infer<S>> {
    const name = this.artifactName(stage, options.variant);
    const raw: unknown = JSON.parse(await readFile(this.path(name), "utf8"));
    return options.schema ? parseContract(name, options.schema, raw) : (raw as z.infer<S>);
  }

  // --- Run state -----------------------------------------------------------------------------

  async readState(): Promise<RunState> {
    const raw: unknown = JSON.parse(await readFile(this.path(STATE_FILE), "utf8"));
    return parseContract("RunState", RunStateSchema, raw);
  }

  /**
   * Read-modify-write of run-state.json. `mutate` may edit the draft in place or return a new state.
   * The result is validated before it is written; an invalid state leaves the file untouched.
   */
  updateState(mutate: (draft: RunState) => RunState | void): Promise<RunState> {
    const task = this.stateQueue.then(async () => {
      const current = await this.readState();
      const draft = structuredClone(current);
      const next = mutate(draft) ?? draft;
      const validated = parseContract("RunState", RunStateSchema, { ...next, updatedAt: this.now().toISOString() });
      await atomicWriteFile(this.path(STATE_FILE), canonicalJsonPretty(validated));
      return validated;
    });
    // Keep the queue alive after a failed update.
    this.stateQueue = task.catch(() => undefined);
    return task;
  }

  /** Merges `patch` into the record of `stage` and sets it as the current stage. */
  markStage(stage: PipelineStage, patch: Partial<StageRecord>): Promise<RunState> {
    return this.updateState((state) => {
      state.currentStage = stage;
      state.stages[stage] = { ...(state.stages[stage] ?? { status: "pending" }), ...patch };
    });
  }

  // --- Local-only vault ----------------------------------------------------------------------

  async writeLocalVault(vault: PiiVault): Promise<void> {
    await atomicWriteFile(this.path(VAULT_FILE), canonicalJsonPretty(parseContract("PiiVault", PiiVaultSchema, vault)));
  }

  async readLocalVault(): Promise<PiiVault> {
    const raw: unknown = JSON.parse(await readFile(this.path(VAULT_FILE), "utf8"));
    return parseContract("PiiVault", PiiVaultSchema, raw);
  }
}

