/**
 * Repeated-value consistency (C2 `evidence.repeated_values`): the same fact stated in two articles must carry the same value.
 *
 * Sections are drafted one by one, so a period that two articles both mention (the rejoin wait in T06 and T07, the notice
 * period of a terms change) can drift. Each sentence is matched against a small topic table; a sentence that names exactly
 * one period for exactly one topic contributes a value. Values are compared with the ledger (when its text states the topic
 * unambiguously) and across sections. Sentences with two different periods ("7일 전, 불리한 경우 30일 전") are skipped.
 */
import type { DocAST, Inline } from "../../contracts/ast";
import type { FactLedger } from "../../contracts/fact-ledger";

interface Topic {
  readonly key: string;
  readonly label: string;
  readonly all: readonly RegExp[];
  readonly none: readonly RegExp[];
}

const REJOIN = /재가입|다시\s*가입/;
const LOSS = /상실|제명|박탈/;
const CHANGE = /(약관|이용약관).{0,40}(개정|변경)|(개정|변경).{0,40}(약관)/;

export const CONSISTENCY_TOPICS: readonly Topic[] = [
  { key: "rejoin_after_withdrawal", label: "탈퇴 후 재가입 대기 기간", all: [REJOIN, /탈퇴/], none: [LOSS] },
  { key: "rejoin_after_loss", label: "자격 상실 후 재가입 제한 기간", all: [REJOIN, LOSS], none: [/탈퇴/] },
  { key: "terms_change_notice", label: "약관 개정 공지 기간", all: [CHANGE, /시행일|적용일/], none: [/불리/] },
  { key: "terms_change_notice_adverse", label: "불리한 약관 개정 공지 기간", all: [CHANGE, /시행일|적용일/, /불리/], none: [] },
];

const DATE = /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}/g;
const PERIOD = /(\d+)\s*(영업일|일|개월|년)/g;

/** The single period a sentence states, or null when it states none or several different ones. */
export function singlePeriod(sentence: string): string | null {
  const values = new Set([...sentence.replace(DATE, " ").matchAll(PERIOD)].map((m) => `${m[1]}${m[2]}`));
  return values.size === 1 ? [...values][0]! : null;
}

/** The topic a sentence is about, or null when it matches none or more than one. */
export function topicOf(sentence: string): Topic | null {
  const hits = CONSISTENCY_TOPICS.filter((t) => t.all.every((r) => r.test(sentence)) && !t.none.some((r) => r.test(sentence)));
  return hits.length === 1 ? hits[0]! : null;
}

export const sentencesOf = (text: string): string[] => text.split(/(?<=[.。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

export interface StatedValue {
  readonly topic: string;
  readonly label: string;
  readonly value: string;
  readonly sectionId: string;
  readonly path: string;
  readonly sentence: string;
}

const runsText = (runs: readonly Inline[]): string => runs.map((r) => (r.t === "text" || r.t === "link" ? r.text : "")).join("");

/** Topic values the reader-facing text states (manual-review and other notes are not reader text and are skipped). */
export function statedValues(ast: DocAST): StatedValue[] {
  const out: StatedValue[] = [];
  ast.sections.forEach((sec, s) => {
    sec.blocks.forEach((block, b) => {
      const base = `sections[${s}].blocks[${b}]`;
      const parts: { path: string; text: string }[] =
        block.t === "para" ? [{ path: `${base}.runs`, text: runsText(block.runs) }]
        : block.t === "list" ? block.items.map((it, i) => ({ path: `${base}.items[${i}]`, text: runsText(it) }))
        : block.t === "table" ? block.rows.map((row, r) => ({ path: `${base}.rows[${r}]`, text: row.map(runsText).join(" ") }))
        : [];
      for (const p of parts) {
        for (const sentence of sentencesOf(p.text)) {
          const topic = topicOf(sentence);
          const value = topic ? singlePeriod(sentence) : null;
          if (topic && value) out.push({ topic: topic.key, label: topic.label, value, sectionId: sec.id, path: p.path, sentence });
        }
      }
    });
  });
  return out;
}

/** Topic values the confirmed ledger text states unambiguously (one value per topic). */
export function ledgerValues(ledger: Pick<FactLedger, "slots">, prefix: string): Record<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const [id, e] of Object.entries(ledger.slots)) {
    if (!id.startsWith(prefix) || e.status !== "filled" || typeof e.value !== "string") continue;
    for (const sentence of sentencesOf(e.value)) {
      const topic = topicOf(sentence);
      const value = topic ? singlePeriod(sentence) : null;
      if (topic && value) seen.set(topic.key, (seen.get(topic.key) ?? new Set()).add(value));
    }
  }
  return Object.fromEntries([...seen].filter(([, v]) => v.size === 1).map(([k, v]) => [k, [...v][0]!]));
}

export interface Inconsistency {
  readonly stated: StatedValue;
  /** The value the text should carry, and where it comes from. */
  readonly expected: string;
  readonly source: "ledger" | readonly string[];
}

/**
 * Stated values that disagree with the ledger, or (when the ledger is silent on the topic) with the value stated in the most
 * sections (ties go to the first section in document order).
 */
export function findInconsistencies(stated: readonly StatedValue[], ledger: Readonly<Record<string, string>>): Inconsistency[] {
  const out: Inconsistency[] = [];
  for (const topic of [...new Set(stated.map((v) => v.topic))]) {
    const rows = stated.filter((v) => v.topic === topic);
    const truth = ledger[topic];
    if (truth !== undefined) {
      for (const v of rows) if (v.value !== truth) out.push({ stated: v, expected: truth, source: "ledger" });
      continue;
    }
    const sectionsBy = new Map<string, Set<string>>();
    for (const v of rows) sectionsBy.set(v.value, (sectionsBy.get(v.value) ?? new Set()).add(v.sectionId));
    if (sectionsBy.size < 2) continue;
    const [majority, where] = [...sectionsBy].sort((a, b) => b[1].size - a[1].size)[0]!;
    for (const v of rows) if (v.value !== majority) out.push({ stated: v, expected: majority, source: [...where].sort() });
  }
  return out;
}
