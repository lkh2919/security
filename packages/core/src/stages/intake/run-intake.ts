/**
 * R1 Intake & Mask stage (design R3 row R1): STT result + service form -> MaskedTranscript,
 * FormSlots and a LOCAL PiiVault. Code only, zero LLM tokens.
 *
 * VAULT HANDLING (hard rule): the vault holds the only copy of real values. It is returned to the
 * caller in memory and must NOT be written to the stage cache, the run store, logs or any LLM
 * payload. `runIntakeCached` enforces this: only `{ maskedTranscript, formSlots }` go through
 * `runCachedStage`; the cache key uses hashes of the raw inputs, never the raw text. Masking is
 * deterministic and cheap, so it always re-runs (even on a cache hit) to rebuild the vault.
 * A masking failure throws and stops the run; there is no fallback that passes unmasked text on.
 */
import { z } from "zod";
import type { SttResult } from "../../adapters/stt/types";
import { MaskedTranscriptSchema, type MaskedTranscript } from "../../contracts/masked-transcript";
import { FormSlotsSchema, type FormSlots } from "../../contracts/form-slots";
import type { PiiVault } from "../../contracts/pii-vault";
import { PiiVaultSchema } from "../../contracts/pii-vault";
import { RunIdSchema } from "../../contracts/common";
import { hashJson, sha256Hex } from "../../pipeline/canonical";
import { runCachedStage, type RunCachedStageResult } from "../../pipeline/run-stage";
import type { RunStore } from "../../pipeline/run-store";
import type { StageCache } from "../../pipeline/stage-cache";
import { parseFormRaw, maskForm, registerFormNames } from "./form-parser";
import { assertAllNoPii } from "./gate";
import { escapePlaceholders, sanitizeText } from "./sanitize";
import { MASKER_VERSION, PiiMasker, type MaskOptions } from "./masker";
import { segmentTranscript } from "./segmenter";

export interface IntakeInput {
  readonly runId: string;
  /** Raw transcript from an SttAdapter. */
  readonly transcript: SttResult;
  /** Raw service form content (JSON or Markdown `key: value`). */
  readonly form: string;
}

/**
 * `masking: "off"` (default, user decision 2026-09-30): no PII masking and no residual gate; text is still
 * sanitized (NFKC, invisible characters) and stays fenced as untrusted data. `"basic"` runs the PiiMasker.
 */
export type MaskingMode = "off" | "basic";

export interface IntakeOptions extends Omit<MaskOptions, "runId"> {
  readonly masking?: MaskingMode;
}

export const MASKING_OFF_VERSION = "off-1";

export interface IntakeResult {
  readonly maskedTranscript: MaskedTranscript;
  readonly formSlots: FormSlots;
  /** LOCAL ONLY. Never cache, persist to the run store, log or send to an LLM. */
  readonly vault: PiiVault;
}

const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*_\d+)\}\}/g;

function runIntakeOff(input: IntakeInput, runId: string): IntakeResult {
  const clean = (t: string): string => escapePlaceholders(sanitizeText(t));
  const segments = segmentTranscript(input.transcript).map((s) => ({
    id: s.id,
    ...(s.speaker ? { speaker: clean(s.speaker) } : {}),
    ...(s.startMs !== undefined ? { startMs: s.startMs } : {}),
    ...(s.endMs !== undefined ? { endMs: s.endMs } : {}),
    text: clean(s.text),
  }));
  const maskedTranscript = MaskedTranscriptSchema.parse({
    runId,
    source: input.transcript.source,
    language: input.transcript.language,
    maskerVersion: MASKING_OFF_VERSION,
    segments,
    placeholders: [],
  });
  const formSlots = maskForm(parseFormRaw(input.form), { mask: clean }, runId);
  return { maskedTranscript, formSlots, vault: PiiVaultSchema.parse({ runId, entries: {} }) };
}

export function runIntake(input: IntakeInput, opts: IntakeOptions = {}): IntakeResult {
  const runId = RunIdSchema.parse(input.runId);
  if ((opts.masking ?? "off") === "off") return runIntakeOff(input, runId);
  const masker = new PiiMasker({ ...opts, runId });
  const rawForm = parseFormRaw(input.form);
  registerFormNames(rawForm, masker);

  const raw = segmentTranscript(input.transcript);
  // 1. structural masking, 2. name discovery (speaker labels + contexts), 3. name masking.
  const structured = raw.map((s) => masker.maskStructured(s.text));
  masker.registerSpeakerLabels(raw.flatMap((s) => (s.speaker ? [s.speaker] : [])));
  masker.discoverNames(structured);
  const segments = raw.map((s, i) => ({
    id: s.id,
    ...(s.speaker ? { speaker: masker.maskSpeaker(s.speaker) } : {}),
    ...(s.startMs !== undefined ? { startMs: s.startMs } : {}),
    ...(s.endMs !== undefined ? { endMs: s.endMs } : {}),
    text: masker.maskNames(structured[i]),
  }));

  const formSlots = maskForm(rawForm, masker, runId);
  const vault = PiiVaultSchema.parse(masker.vault());

  const kindOf = (key: string): string => vault.entries[key]?.kind ?? "UNKNOWN";
  const counts = new Map<string, number>();
  for (const s of segments) for (const m of `${s.speaker ?? ""}\n${s.text}`.matchAll(PLACEHOLDER_RE)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const maskedTranscript = MaskedTranscriptSchema.parse({
    runId,
    source: input.transcript.source,
    language: input.transcript.language,
    maskerVersion: MASKER_VERSION,
    segments,
    placeholders: [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, occurrences]) => ({ key, kind: kindOf(key), occurrences })),
  });

  // Final hard gate over every string that can leave R1. Throws PiiResidualError (no values in message).
  assertAllNoPii(collectStrings(maskedTranscript, formSlots), { ...opts, vault });
  return { maskedTranscript, formSlots, vault };
}

function collectStrings(t: MaskedTranscript, f: FormSlots): { where: string; text: string }[] {
  const items: { where: string; text: string }[] = [];
  for (const s of t.segments) {
    items.push({ where: `${s.id}.text`, text: s.text });
    if (s.speaker) items.push({ where: `${s.id}.speaker`, text: s.speaker });
  }
  const walk = (v: unknown, where: string): void => {
    if (typeof v === "string") items.push({ where, text: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        items.push({ where: `${where}.<key>`, text: k });
        walk(x, `${where}.${k}`);
      }
  };
  walk({ ...f, runId: undefined }, "form");
  return items;
}

export const IntakeCacheOutputSchema = z.strictObject({ maskedTranscript: MaskedTranscriptSchema, formSlots: FormSlotsSchema });

export interface CachedIntakeResult extends IntakeResult {
  readonly stage: RunCachedStageResult<z.infer<typeof IntakeCacheOutputSchema>>;
}

/**
 * Runs intake through the pipeline stage cache WITHOUT letting the vault (or raw text) touch it.
 * Stage id is `mask` (the hard gate); the cache key input is hashes only.
 */
export async function runIntakeCached(
  deps: { store: RunStore; cache: StageCache; now?: () => Date },
  input: IntakeInput,
  opts: IntakeOptions = {},
): Promise<CachedIntakeResult> {
  const maskingVersion = (opts.masking ?? "off") === "off" ? MASKING_OFF_VERSION : MASKER_VERSION;
  const result = runIntake(input, opts); // always recomputed: cheap, deterministic, rebuilds the vault
  const stage = await runCachedStage(deps, {
    stage: "mask",
    parts: {
      stageId: "R1",
      input: { runId: input.runId, transcriptSha256: hashJson(input.transcript), formSha256: sha256Hex(input.form), options: optionsDigest(opts) },
      promptVersion: maskingVersion,
      modelId: null,
      versions: { masker: maskingVersion },
    },
    schema: IntakeCacheOutputSchema,
    compute: () => ({ maskedTranscript: result.maskedTranscript, formSlots: result.formSlots }),
  });
  return { ...result, stage };
}

function optionsDigest(opts: IntakeOptions): string {
  const s = (r: RegExp | string): string => (typeof r === "string" ? r : r.toString());
  return sha256Hex(
    JSON.stringify({
      m: opts.masking ?? "off",
      d: opts.publicDomains ?? null,
      e: (opts.employeeIdPatterns ?? []).map(s),
      h: (opts.internalHostPatterns ?? []).map(s),
      x: (opts.extraRules ?? []).map((r) => [r.kind, s(r.pattern)]),
      // Hashed (not listed) so cached keys never contain real names.
      n: sha256Hex(JSON.stringify(opts.knownNames ?? [])),
      s: opts.nameStopWords ?? [],
    }),
  );
}
