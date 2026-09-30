/**
 * Deterministic post-processing of R2 output (all code, zero tokens):
 *  1. verify evidence: segment must exist and contain the quote verbatim (a quote found in exactly one
 *     other segment is re-pointed there); unverifiable quotes are dropped;
 *  2. a `filled` claim with no verified evidence is downgraded to `needs_manual_review` (value withheld);
 *  3. registry membership and light type coercion (yes_no, number);
 *  4. merge candidates across chunks (arrays union, equal scalars merge, differing scalars -> conflict);
 *  5. merge with form values: the form wins unless the transcript conflicts, then status is `conflict`.
 */
import { MAX_QUOTE_LENGTH, type JsonValue, type SlotRegistry } from "../../contracts/common";
import { createFactLedgerSchema, type Evidence, type FactLedger, type SlotEntry } from "../../contracts/fact-ledger";
import type { FormSlots } from "../../contracts/form-slots";
import { findSegment, type MaskedTranscript } from "../../contracts/masked-transcript";
import { canonicalJson } from "../../pipeline/canonical";
import { CONFIDENCE_VALUE, type ExtractOutput } from "./schema";

export type TranscriptEvidence = Extract<Evidence, { source: "transcript" }>;

export interface DroppedItem {
  readonly slotId: string;
  readonly reason: "unknown_slot" | "bad_value" | "null_value" | "no_valid_evidence" | "evidence_repaired" | "evidence_dropped" | "form_unknown_slot";
  readonly detail?: string;
}

export interface Candidate {
  readonly slotId: string;
  readonly status: "filled" | "needs_manual_review";
  readonly value: JsonValue;
  readonly confidence: number;
  readonly evidence: TranscriptEvidence[];
}

const MAX_EVIDENCE_PER_SLOT = 5;

/** Verifies one quote; returns the (possibly re-pointed) evidence or null. */
export function verifyQuote(transcript: MaskedTranscript, segmentId: string, rawQuote: string): { evidence: TranscriptEvidence; repaired: boolean } | null {
  const quote = rawQuote.trim().slice(0, MAX_QUOTE_LENGTH);
  if (quote.length === 0) return null;
  const seg = findSegment(transcript, segmentId);
  if (seg?.text.includes(quote)) return { evidence: { source: "transcript", segmentId, quote }, repaired: false };
  const hits = transcript.segments.filter((s) => s.text.includes(quote));
  if (hits.length === 1) return { evidence: { source: "transcript", segmentId: hits[0].id, quote }, repaired: true };
  return null;
}

export function coerce(type: string, value: JsonValue): JsonValue | undefined {
  if (value === null) return undefined;
  if (type === "yes_no") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (["true", "yes", "y", "예", "네"].includes(v)) return true;
      if (["false", "no", "n", "아니오", "아니요"].includes(v)) return false;
    }
    return undefined;
  }
  if (type === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return undefined;
  }
  if ((type === "multi" || type === "table") && !Array.isArray(value)) return [value];
  return value;
}

/** Turns raw model output for ONE chunk into verified candidates. */
export function candidatesFromOutput(output: ExtractOutput, transcript: MaskedTranscript, registry: SlotRegistry, dropped: DroppedItem[]): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of output.slots) {
    const def = registry.get(raw.slotId);
    if (!def) {
      dropped.push({ slotId: raw.slotId, reason: "unknown_slot" });
      continue;
    }
    const evidence: TranscriptEvidence[] = [];
    for (const ev of raw.evidence) {
      const v = verifyQuote(transcript, ev.segmentId, ev.quote);
      if (!v) {
        dropped.push({ slotId: raw.slotId, reason: "evidence_dropped", detail: ev.segmentId });
        continue;
      }
      if (v.repaired) dropped.push({ slotId: raw.slotId, reason: "evidence_repaired", detail: `${ev.segmentId}->${v.evidence.segmentId}` });
      if (!evidence.some((e) => e.segmentId === v.evidence.segmentId && e.quote === v.evidence.quote)) evidence.push(v.evidence);
    }
    if (raw.status === "needs_manual_review") {
      out.push({ slotId: raw.slotId, status: "needs_manual_review", value: null, confidence: 0, evidence });
      continue;
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw.valueJson) as JsonValue;
    } catch {
      dropped.push({ slotId: raw.slotId, reason: "bad_value" });
      continue;
    }
    if (parsed === null) {
      dropped.push({ slotId: raw.slotId, reason: "null_value" });
      continue;
    }
    const value = coerce(def.type, parsed);
    if (value === undefined) {
      dropped.push({ slotId: raw.slotId, reason: "bad_value", detail: def.type });
      continue;
    }
    if (evidence.length === 0) {
      dropped.push({ slotId: raw.slotId, reason: "no_valid_evidence" });
      out.push({ slotId: raw.slotId, status: "needs_manual_review", value: null, confidence: 0, evidence: [] });
      continue;
    }
    out.push({ slotId: raw.slotId, status: "filled", value, confidence: CONFIDENCE_VALUE[raw.confidence], evidence });
  }
  return out;
}

const canon = (v: JsonValue): string => canonicalJson(v);

function unionEvidence(list: TranscriptEvidence[][]): TranscriptEvidence[] {
  const seen = new Set<string>();
  const out: TranscriptEvidence[] = [];
  for (const ev of list.flat()) {
    const key = `${ev.segmentId}\u0000${ev.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out.slice(0, MAX_EVIDENCE_PER_SLOT);
}

interface TranscriptSlot {
  status: "filled" | "needs_manual_review" | "conflict";
  value: JsonValue;
  confidence: number;
  evidence: TranscriptEvidence[];
}

/** Merges candidates for one slot from all chunks. */
export function mergeCandidates(cands: Candidate[]): TranscriptSlot {
  const filled = cands.filter((c) => c.status === "filled");
  if (filled.length === 0) return { status: "needs_manual_review", value: null, confidence: 0, evidence: unionEvidence(cands.map((c) => c.evidence)) };
  const confidence = Math.max(...filled.map((c) => c.confidence));
  const evidence = unionEvidence(filled.map((c) => c.evidence));
  if (filled.every((c) => Array.isArray(c.value))) {
    const seen = new Set<string>();
    const rows: JsonValue[] = [];
    for (const c of filled) {
      for (const row of c.value as JsonValue[]) {
        const k = canon(row);
        if (!seen.has(k)) {
          seen.add(k);
          rows.push(row);
        }
      }
    }
    return { status: "filled", value: rows, confidence, evidence };
  }
  const distinct = new Set(filled.map((c) => canon(c.value)));
  if (distinct.size === 1) return { status: "filled", value: filled[0].value, confidence, evidence };
  return { status: "conflict", value: null, confidence: 0, evidence };
}

function looseEqual(a: JsonValue, b: JsonValue): boolean {
  if (canon(a) === canon(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    const bs = new Set(b.map(canon));
    return a.every((x) => bs.has(canon(x)));
  }
  return typeof a !== "object" && typeof b !== "object" && String(a).trim() === String(b).trim();
}

/** `t` is compatible with the form value `f` when it says the same thing or a subset of it. */
export function compatibleWithForm(f: JsonValue, t: JsonValue): boolean {
  if (Array.isArray(f) && Array.isArray(t)) return looseEqual(t, f);
  return looseEqual(f, t);
}

const formEvidence = (slotId: string, value: JsonValue): Evidence => ({ source: "form", ref: `form.slots.${slotId}`, quote: JSON.stringify(value).slice(0, MAX_QUOTE_LENGTH) });

export function buildLedger(args: {
  runId: string;
  registry: SlotRegistry;
  candidates: readonly Candidate[];
  form: Pick<FormSlots, "slots">;
  dropped: DroppedItem[];
}): FactLedger {
  const bySlot = new Map<string, Candidate[]>();
  for (const c of args.candidates) bySlot.set(c.slotId, [...(bySlot.get(c.slotId) ?? []), c]);

  const slots: Record<string, SlotEntry> = {};
  for (const [slotId, cands] of [...bySlot.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    slots[slotId] = mergeCandidates(cands);
  }

  for (const [slotId, formValue] of Object.entries(args.form.slots).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!args.registry.has(slotId)) {
      args.dropped.push({ slotId, reason: "form_unknown_slot" });
      continue;
    }
    // Form answers are typed by the registry too (the form parser keeps "예" / "아니오" as strings).
    const fv = coerce(args.registry.get(slotId)?.type ?? "", formValue as JsonValue) ?? (formValue as JsonValue);
    const t = slots[slotId];
    if (!t || t.status === "needs_manual_review") {
      slots[slotId] = { status: "filled", value: fv, confidence: 1, evidence: [formEvidence(slotId, fv), ...(t?.evidence ?? [])].slice(0, MAX_EVIDENCE_PER_SLOT) };
    } else if (t.status === "filled" && compatibleWithForm(fv, t.value)) {
      slots[slotId] = { status: "filled", value: fv, confidence: 1, evidence: [formEvidence(slotId, fv), ...t.evidence].slice(0, MAX_EVIDENCE_PER_SLOT) };
    } else {
      // Transcript contradicts the form (or transcript answers already conflicted): needs a human decision.
      slots[slotId] = { status: "conflict", value: null, confidence: 0, evidence: [formEvidence(slotId, fv), ...t.evidence].slice(0, MAX_EVIDENCE_PER_SLOT) };
    }
  }

  return createFactLedgerSchema(args.registry).parse({ runId: args.runId, jurisdiction: "kr", slotRegistryVersion: args.registry.version, slots });
}
