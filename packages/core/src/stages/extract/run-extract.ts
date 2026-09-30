/**
 * R2 Fact Extractor (design R3, stage "extract", Haiku): MaskedTranscript + FormSlots + slot map -> FactLedger.
 *
 * The model sees only masked text, wrapped as untrusted data. Its output is a weak, flat structure
 * (`ExtractOutputSchema`); every claim is verified in code before it enters the ledger
 * (see `ledger-builder.ts`). Long transcripts are chunked; results are merged deterministically.
 */
import type { SlotRegistry } from "../../contracts/common";
import type { FactLedger } from "../../contracts/fact-ledger";
import type { FormSlots } from "../../contracts/form-slots";
import type { MaskedTranscript } from "../../contracts/masked-transcript";
import type { InterviewTemplate } from "../../contracts/interview-template";
import type { LlmClient, TokenUsage } from "../../llm/client";
import { UNTRUSTED_NOTICE, wrapUntrusted } from "../intake/sanitize";
import type { SlotHint } from "../coverage/load-kb";
import { chunkSegments, DEFAULT_MAX_CHUNK_CHARS, DEFAULT_OVERLAP_SEGMENTS } from "./chunker";
import { buildSlotMap } from "./extraction-map";
import { buildLedger, candidatesFromOutput, type Candidate, type DroppedItem } from "./ledger-builder";
import { loadPromptFile, type PromptFile } from "./prompt";
import { ExtractOutputSchema } from "./schema";

export const EXTRACT_PROMPT_PATH = "extract/v1.md";

export interface ExtractInput {
  readonly maskedTranscript: MaskedTranscript;
  readonly formSlots: FormSlots;
  readonly template: InterviewTemplate;
  readonly registry: SlotRegistry;
  readonly slotHints?: Readonly<Record<string, SlotHint>>;
}

export interface ExtractDeps {
  readonly llm: LlmClient;
  readonly prompt?: PromptFile;
  readonly maxChunkChars?: number;
  readonly overlapSegments?: number;
}

export interface ExtractResult {
  readonly ledger: FactLedger;
  /** Everything code discarded or repaired; useful for the run log and tests. */
  readonly dropped: readonly DroppedItem[];
  readonly chunks: number;
  readonly promptVersion: string;
  readonly usage: TokenUsage;
}

/** Static, cacheable prefix: role + rules + slot map. Identical for every chunk and every run of a template version. */
export function buildExtractSystem(prompt: PromptFile, input: Pick<ExtractInput, "template" | "registry" | "slotHints">): string {
  return `${prompt.body}\n\n## SLOT MAP (template ${input.template.version}, registry ${input.registry.version})\n${buildSlotMap(input)}`;
}

function formContext(form: FormSlots): string {
  const compact = {
    serviceName: form.serviceName,
    slots: Object.fromEntries(Object.entries(form.slots).sort(([a], [b]) => (a < b ? -1 : 1))),
    flows: form.flows,
  };
  return JSON.stringify(compact);
}

export async function runExtract(deps: ExtractDeps, input: ExtractInput): Promise<ExtractResult> {
  const prompt = deps.prompt ?? loadPromptFile(EXTRACT_PROMPT_PATH);
  const system = buildExtractSystem(prompt, input);
  const chunks = chunkSegments(input.maskedTranscript.segments, deps.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS, deps.overlapSegments ?? DEFAULT_OVERLAP_SEGMENTS);
  const form = formContext(input.formSlots);

  const dropped: DroppedItem[] = [];
  const candidates: Candidate[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

  for (const [i, chunk] of chunks.entries()) {
    const user = [
      `FORM (already answered by the operator; authoritative unless the transcript contradicts it):`,
      form,
      ``,
      `TRANSCRIPT CHUNK ${i + 1} of ${chunks.length}. ${UNTRUSTED_NOTICE}`,
      wrapUntrusted({ segments: chunk }),
      ``,
      `Return the slot candidates you can support with verbatim quotes from this chunk.`,
    ].join("\n");
    const res = await deps.llm.callStructured({
      stageId: "R2",
      system,
      user,
      schema: ExtractOutputSchema,
      schemaName: "ExtractOutput",
      promptVersion: prompt.version,
    });
    usage = {
      inputTokens: usage.inputTokens + res.usage.inputTokens,
      outputTokens: usage.outputTokens + res.usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens + res.usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens + res.usage.cacheCreationInputTokens,
    };
    candidates.push(...candidatesFromOutput(res.data, input.maskedTranscript, input.registry, dropped));
  }

  const ledger = buildLedger({ runId: input.maskedTranscript.runId, registry: input.registry, candidates, form: input.formSlots, dropped });
  return { ledger, dropped, chunks: chunks.length, promptVersion: prompt.version, usage };
}
