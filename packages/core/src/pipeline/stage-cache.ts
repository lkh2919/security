/**
 * Stage cache (design R7 handoffs, R10 item 5, R11.3).
 *
 * Key = SHA-256 of canonical JSON of { stage, prompt semver, model ID, rule-pack / manifest
 * versions, stage input }. A matching key reuses the stored artifact and skips the stage, so an
 * identical replay returns identical output. Any change to the prompt version, model, KB stamps,
 * or input yields a new key.
 *
 * Entries live in `<dir>/<stageId>/<key>.json`, written atomically. A corrupt, mismatched, expired
 * or schema-invalid entry is treated as a miss (never as an error) and is overwritten on the next put.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { atomicWriteFile } from "./fs-atomic";
import { canonicalJson, canonicalJsonPretty, sha256Hex } from "./canonical";

const CACHE_FORMAT_VERSION = 1;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface StageCacheKeyParts {
  /** Stage identifier, e.g. `R2` or `draft.S05`. Used as a directory name. */
  readonly stageId: string;
  /** Everything the stage reads. Must be JSON-serializable. */
  readonly input: unknown;
  /** Prompt semver, or the implementation version for code-only stages. */
  readonly promptVersion: string;
  /** Pinned model ID, or null for code-only stages. */
  readonly modelId: string | null;
  /** Rule-pack, manifest, clause-library, house-style and slot-registry versions in effect. */
  readonly versions: Readonly<Record<string, string>>;
}

export function computeCacheKey(parts: StageCacheKeyParts): string {
  if (!SAFE_NAME.test(parts.stageId)) throw new Error(`invalid stageId for cache: ${parts.stageId}`);
  return sha256Hex(
    canonicalJson({
      format: CACHE_FORMAT_VERSION,
      stageId: parts.stageId,
      promptVersion: parts.promptVersion,
      modelId: parts.modelId,
      versions: parts.versions,
      input: parts.input,
    }),
  );
}

interface CacheEntryFile {
  format: number;
  key: string;
  stageId: string;
  createdAt: string;
  promptVersion: string;
  modelId: string | null;
  versions: Record<string, string>;
  output: unknown;
}

export type CacheLookup<T> = { hit: true; key: string; output: T; createdAt: string } | { hit: false; key: string };

export interface StageCacheOptions {
  /** Cache root directory (for example `path.join(runsRoot, ".cache")`). */
  readonly dir: string;
  /** Clock injection for tests. */
  readonly now?: () => Date;
}

export interface LookupOptions<S extends z.ZodType> {
  /** Validates the stored output; a failing entry is a miss. */
  readonly schema?: S;
  /** Entries older than this are misses (used for the 24 h freshness cache). */
  readonly maxAgeMs?: number;
}

export class StageCache {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(options: StageCacheOptions) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
  }

  entryPath(parts: StageCacheKeyParts): string {
    return join(this.dir, parts.stageId, `${computeCacheKey(parts)}.json`);
  }

  async get<S extends z.ZodType>(parts: StageCacheKeyParts, options: LookupOptions<S> = {}): Promise<CacheLookup<z.infer<S>>> {
    const key = computeCacheKey(parts);
    let entry: CacheEntryFile;
    try {
      entry = JSON.parse(await readFile(join(this.dir, parts.stageId, `${key}.json`), "utf8")) as CacheEntryFile;
    } catch {
      return { hit: false, key };
    }
    if (entry?.format !== CACHE_FORMAT_VERSION || entry.key !== key || entry.stageId !== parts.stageId || typeof entry.createdAt !== "string") {
      return { hit: false, key };
    }
    if (options.maxAgeMs !== undefined && this.now().getTime() - new Date(entry.createdAt).getTime() > options.maxAgeMs) {
      return { hit: false, key };
    }
    if (options.schema) {
      const parsed = options.schema.safeParse(entry.output);
      if (!parsed.success) return { hit: false, key };
      return { hit: true, key, output: parsed.data, createdAt: entry.createdAt };
    }
    return { hit: true, key, output: entry.output as z.infer<S>, createdAt: entry.createdAt };
  }

  async put(parts: StageCacheKeyParts, output: unknown): Promise<string> {
    const key = computeCacheKey(parts);
    const entry: CacheEntryFile = {
      format: CACHE_FORMAT_VERSION,
      key,
      stageId: parts.stageId,
      createdAt: this.now().toISOString(),
      promptVersion: parts.promptVersion,
      modelId: parts.modelId,
      versions: { ...parts.versions },
      output,
    };
    await atomicWriteFile(join(this.dir, parts.stageId, `${key}.json`), canonicalJsonPretty(entry));
    return key;
  }

  /** Returns the cached output on a hit; otherwise runs `compute`, stores its result, and returns it. */
  async getOrCompute<S extends z.ZodType>(
    parts: StageCacheKeyParts,
    compute: () => Promise<z.infer<S>> | z.infer<S>,
    options: LookupOptions<S> = {},
  ): Promise<{ output: z.infer<S>; hit: boolean; key: string }> {
    const found = await this.get(parts, options);
    if (found.hit) return { output: found.output, hit: true, key: found.key };
    const output = await compute();
    if (options.schema) options.schema.parse(output);
    const key = await this.put(parts, output);
    return { output, hit: false, key };
  }
}
