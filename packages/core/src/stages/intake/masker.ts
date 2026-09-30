/**
 * PiiMasker: the R1 masking hard gate (code only, zero LLM tokens).
 *
 * Flow per run: (1) `maskStructured` on every segment (numbers, emails, URLs, addresses...),
 * (2) `discoverNames` on the structurally-masked text plus speaker labels, (3) `maskNames`/`maskSpeaker`.
 * Placeholders are stable per value within a run; originals are kept ONLY in this object's vault.
 */
import type { PiiVault } from "../../contracts/pii-vault";
import { NameBook, isPlausibleKoreanName } from "./names";
import { buildRules, findHits, type PatternOptions, type PiiRule } from "./patterns";
import { sanitizeText } from "./sanitize";

export const MASKER_VERSION = "1.0.0";

export interface MaskOptions extends PatternOptions {
  runId: string;
  /** Names that are always masked (e.g. from the form's owner field). */
  knownNames?: readonly string[];
  /** Extra words never treated as personal names. */
  nameStopWords?: readonly string[];
}

const ROLE_LABEL =
  /^(?:인터뷰어|인터뷰이|진행자|면담자|답변자|응답자|질문자|사회자|개발자|기획자|디자이너|담당자|운영자|관리자|참석자\s*\d*|화자\s*\d*|발화자\s*\d*|pm|po|cto|speaker[\s_-]*\w*|interviewer|interviewee|host|guest|moderator|participant\s*\d*|user|assistant|unknown)$/i;
const LATIN_NAME = /^[A-Za-z][A-Za-z.'-]*(?:\s[A-Za-z.'-]+){0,2}$/;

export function isRoleLabel(s: string): boolean {
  return ROLE_LABEL.test(s.trim());
}

export class PiiMasker {
  private readonly rules: PiiRule[];
  private readonly names: NameBook;
  private readonly entries: Record<string, { kind: string; value: string }> = {};
  private readonly index = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly opts: MaskOptions) {
    this.rules = buildRules(opts);
    this.names = new NameBook(opts.nameStopWords);
    for (const n of opts.knownNames ?? []) this.registerName(n);
  }

  /** Registers a name proven by the caller (form owner field, config). */
  registerName(name: string): void {
    this.names.addKnown(name);
  }

  /** Registers a form-field name only if it looks like a person. */
  registerNameIfPlausible(name: string): boolean {
    return this.names.addIfPlausible(name);
  }

  private placeholder(kind: string, identity: string, value: string): string {
    const idKey = `${kind}|${identity}`;
    let key = this.index.get(idKey);
    if (!key) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      key = `${kind}_${n}`;
      this.index.set(idKey, key);
      this.entries[key] = { kind, value };
    }
    return `{{${key}}}`;
  }

  /** Step 1: numbers, emails, URLs, IPs, addresses, IDs. */
  maskStructured(text: string): string {
    let t = sanitizeText(text);
    for (const rule of this.rules) {
      const hits = findHits(t, rule);
      if (!hits.length) continue;
      let out = "";
      let last = 0;
      for (const h of hits) {
        if (h.start < last) continue;
        out += t.slice(last, h.start) + this.placeholder(rule.kind, (rule.identity ?? ((v) => v))(h.value), h.value);
        last = h.end;
      }
      t = out + t.slice(last);
    }
    return t;
  }

  /** Step 2a: speaker labels prove names. */
  registerSpeakerLabels(labels: readonly string[]): void {
    for (const raw of labels) {
      const { base } = splitLabel(sanitizeText(raw));
      if (!base || isRoleLabel(base)) continue;
      if (/^[가-힣]{2,4}$/.test(base)) {
        if (isPlausibleKoreanName(base) || !/[팀부실별적]$/.test(base)) this.names.addKnown(base);
      } else if (LATIN_NAME.test(base)) this.names.addKnown(base);
    }
  }

  /** Step 2b: names introduced by context. Pass structurally-masked text. */
  discoverNames(structuredTexts: readonly string[]): void {
    for (const t of structuredTexts) this.names.discover(t);
  }

  /** Step 3: replace registered names. */
  maskNames(text: string): string {
    return this.names.apply(text, (matched, givenOnly) => {
      const full = givenOnly ? (this.names.fullFor(matched) ?? matched) : matched;
      return this.placeholder("PERSON", full.toLowerCase(), full);
    });
  }

  /** Full masking for text outside the transcript (form values), after names are known. */
  mask(text: string): string {
    return this.maskNames(this.maskStructured(text));
  }

  /** Masks a speaker label; role labels (인터뷰어...) stay, names become placeholders, `(role)` is kept. */
  maskSpeaker(label: string): string {
    const { base, role } = splitLabel(sanitizeText(label).trim());
    const b = isRoleLabel(base) ? base : this.mask(base);
    return role ? `${b} (${this.mask(role)})` : b;
  }

  /** Local-only vault. Never write it to the cache, run store, logs or an LLM payload. */
  vault(): PiiVault {
    return { runId: this.opts.runId, entries: structuredClone(this.entries) };
  }

  /** Public-domain / pattern options in effect, so `assertNoPii` can use the same config. */
  get patternOptions(): PatternOptions {
    return this.opts;
  }
}

function splitLabel(s: string): { base: string; role?: string } {
  const m = s.match(/^(.*?)\s*[(\[]([^)\]]{1,20})[)\]]\s*$/);
  return m && m[1] ? { base: m[1].trim(), role: m[2].trim() } : { base: s.trim() };
}
