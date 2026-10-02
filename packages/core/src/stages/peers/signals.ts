/**
 * Peer signals (design C5, domain expert's table):
 *   P0 `peer_changed`   a section changed after normalization (cosmetic events never count).
 *   P1 `peer_aligned`   the changed paragraph cites an amended article or uses the amendment's new wording / terms.
 *   P2 `group_adoption` k of n peers of a group reach P1 (High or Medium) for the same article key and section inside the window;
 *                       shown for k >= 3 and k/n >= 0.6.
 *
 * Attribution confidence: High = cites the amended article or quotes its new wording; Medium = same section and at least three
 * new terms (two when one is a number); Low = only timing and section overlap ("변경 감지 (원인 미상)", never counted).
 * A peer change "co-occurred" with an amendment; it was never "caused by" it.
 *
 * A signal never creates a finding and never touches a severity: it can only raise the `priority` of a Mode B finding that already
 * exists and rides along as `evidence`. Everything here is recomputable from stored change events and snapshots.
 */
import type { AmendmentDiff, AmendmentUnit } from "../../contracts/amendment-diff";
import type { MonitorFinding } from "../../contracts/monitor-report";
import { PEER_SIGNAL_LABEL, UrgencySignalSchema, type PolicyChangeEvent, type UrgencySignal } from "../../contracts/peers";
import type { RuleSection } from "../../contracts/rulepack";
import { mapUnitsToSections, parseLegalRef, refsRelated } from "../monitor/impact";
import { paragraphsNotIn } from "./changes";
import type { NormalizedPolicy } from "./normalize";

export const DEFAULT_WINDOW_DAYS = 30;
/** How long before the effective date a peer change may still be attributed (amendments are promulgated ahead of time). */
export const DEFAULT_LEAD_DAYS = 180;
export const MIN_ADOPTERS = 3;
export const MIN_ADOPTION_RATIO = 0.6;
const DAY_MS = 86_400_000;

export type Confidence = "high" | "medium" | "low";
export type AlignBasis = "cites_article" | "quotes_new_wording" | "new_terms" | "section_timing";

export interface Alignment {
  readonly articleKey: string;
  readonly sectionId: string;
  readonly confidence: Confidence;
  readonly basis: AlignBasis;
}

const RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

// --- text matching -------------------------------------------------------------------------------------------

const compact = (s: string): string => s.replace(/[\s​]+/g, "");

/** `PIPA:28-8(1)` -> `제28조의8`; matches the article only (not 제280조, not 제28조의9). */
export function citesArticle(text: string, key: string): boolean {
  const ref = parseLegalRef(key);
  const art = /^a(\d+)(?:-(\d+))?$/.exec(ref?.segments[0] ?? "");
  if (!art) return false;
  const base = `제\\s*${art[1]}\\s*조`;
  const re = art[2] ? new RegExp(`${base}\\s*의\\s*${art[2]}(?!\\d)`) : new RegExp(`${base}(?!\\s*의\\s*\\d|\\d)`);
  return re.test(text);
}

const PARTICLE = /(?:으로|에서|에게|까지|부터|이다|한다|하는|하여|에는|에도|은|는|이|가|을|를|의|에|로|와|과|도|만)$/;
const STOP = new Set(["다음", "경우", "법률", "대통령령", "따라", "관한", "있는", "하여", "한다", "이상", "이하", "각호", "그밖", "해당", "필요", "또는", "및", "제항", "제호", "제조", "이를", "그리고"]);

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/[가-힣]{2,}|[A-Za-z]{2,}\d*|\d+[가-힣A-Za-z%]*/g)) {
    let t = m[0];
    if (/[가-힣]/.test(t) && t.length > 2) t = t.replace(PARTICLE, "");
    if (t.length >= 2 || /\d/.test(t)) if (!STOP.has(t)) out.add(t);
  }
  return out;
}

/** Terms the amendment introduced (in `newText`, not in `oldText`). */
export function newTermsOf(unit: AmendmentUnit): string[] {
  const before = tokens(unit.oldText ?? "");
  return [...tokens(unit.newText ?? "")].filter((t) => !before.has(t));
}

/** Minimum run of characters (spaces ignored) that must be copied from the amendment's new wording. */
const QUOTE_RUN = 16;

/** True when the paragraph repeats a run of the amendment's new wording (a run that the old text did not already contain). */
function quotesNewWording(added: string, unit: AmendmentUnit): boolean {
  if (!unit.newText) return false;
  const fresh = compact(unit.newText);
  const old = compact(unit.oldText ?? "");
  const hay = compact(added);
  for (let i = 0; i + QUOTE_RUN <= fresh.length; i++) {
    const run = fresh.slice(i, i + QUOTE_RUN);
    if (!old.includes(run) && hay.includes(run)) return true;
  }
  return false;
}

// --- window --------------------------------------------------------------------------------------------------

/** Window of one amendment: [effective - lead, effective + window]; without a date, the last `window` days up to `asOf`. */
export function inWindow(at: Date, effectiveOn: string | null, asOf: Date, leadDays = DEFAULT_LEAD_DAYS, windowDays = DEFAULT_WINDOW_DAYS): boolean {
  const eff = effectiveOn ? Date.parse(`${effectiveOn}T00:00:00Z`) : null;
  const lo = eff !== null ? eff - leadDays * DAY_MS : asOf.getTime() - windowDays * DAY_MS;
  const hi = (eff !== null ? eff + windowDays * DAY_MS : asOf.getTime()) + DAY_MS;
  return at.getTime() >= lo && at.getTime() < hi;
}

// --- P1 ------------------------------------------------------------------------------------------------------

export interface AlignOptions {
  readonly diffs: readonly AmendmentDiff[];
  readonly ruleSections?: ReadonlyMap<string, RuleSection>;
  /** Law prefix (`PIPA`) -> names a citation may use; when given, a citation counts only next to one of them. */
  readonly lawNames?: (prefix: string) => readonly string[];
  readonly asOf: Date;
  readonly windowDays?: number;
  readonly leadDays?: number;
}

/** Alignments of one change event with the given amendments. `prev` is null when its snapshot was pruned (all text counts as new). */
export function alignEvent(event: PolicyChangeEvent, prev: NormalizedPolicy | null, next: NormalizedPolicy, o: AlignOptions): Alignment[] {
  if (event.cosmeticOnly) return [];
  const at = new Date(event.detectedAt);
  const best = new Map<string, Alignment>();
  const keep = (a: Alignment): void => {
    const k = `${a.articleKey}|${a.sectionId}`;
    const cur = best.get(k);
    if (!cur || RANK[a.confidence] > RANK[cur.confidence]) best.set(k, a);
  };
  for (const diff of o.diffs) {
    if (!inWindow(at, diff.effectiveOn, o.asOf, o.leadDays, o.windowDays)) continue;
    const unitSections = new Map<string, string[]>();
    if (o.ruleSections) for (const s of mapUnitsToSections(diff.units, o.ruleSections).sections) for (const u of s.units) unitSections.set(u.key, [...(unitSections.get(u.key) ?? []), s.sectionId]);
    for (const c of event.changedSections) {
      if (c.kind === "removed") continue;
      const sec = next.sections.find((s) => s.sectionId === c.sectionId);
      const added = paragraphsNotIn(sec, prev?.sections.find((s) => s.sectionId === c.sectionId));
      if (added.length === 0) continue;
      const addedText = added.join(" ");
      for (const unit of diff.units) {
        const mapped = unitSections.get(unit.key) ?? [];
        const names = o.lawNames?.(diff.law) ?? [];
        const cites = added.some((p) => citesArticle(p, unit.key) && (names.length === 0 || names.some((n) => compact(p).includes(compact(n)))));
        const quotes = quotesNewWording(addedText, unit);
        const sectionMatch = mapped.includes(c.sectionId);
        if (cites || quotes) {
          for (const sectionId of mapped.length > 0 ? mapped : [c.sectionId]) keep({ articleKey: unit.key, sectionId, confidence: "high", basis: cites ? "cites_article" : "quotes_new_wording" });
          continue;
        }
        if (!sectionMatch) continue;
        const hits = newTermsOf(unit).filter((t) => addedText.includes(t));
        const strong = hits.length >= 3 || (hits.length >= 2 && hits.some((t) => /\d/.test(t)));
        keep({ articleKey: unit.key, sectionId: c.sectionId, confidence: strong ? "medium" : "low", basis: strong ? "new_terms" : "section_timing" });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.articleKey.localeCompare(b.articleKey) || a.sectionId.localeCompare(b.sectionId));
}

// --- P0, P1, P2 ----------------------------------------------------------------------------------------------

export interface PeerGroupInfo {
  /** Registry peers of the group (Lotte captures are not peers and never count toward k). */
  readonly peers: ReadonlySet<string>;
  /** Peers with at least one usable snapshot. */
  readonly n: number;
}

export interface SignalInput extends AlignOptions {
  readonly events: readonly PolicyChangeEvent[];
  readonly load: (e: PolicyChangeEvent) => Promise<{ prev: NormalizedPolicy | null; next: NormalizedPolicy } | null>;
  readonly groups: ReadonlyMap<string, PeerGroupInfo>;
  readonly minK?: number;
  readonly minRatio?: number;
}

export interface PeerSignals {
  readonly peerChanged: readonly { peerId: string; groupId: string; detectedAt: string; sectionIds: string[] }[];
  readonly peerAligned: readonly { peerId: string; groupId: string; detectedAt: string; alignments: Alignment[] }[];
  readonly groupAdoption: readonly UrgencySignal[];
}

export async function computeSignals(input: SignalInput): Promise<PeerSignals> {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const minK = input.minK ?? MIN_ADOPTERS;
  const minRatio = input.minRatio ?? MIN_ADOPTION_RATIO;
  const changed = input.events.filter((e) => !e.cosmeticOnly && e.changedSections.length > 0);
  const peerChanged = changed.map((e) => ({ peerId: e.peerId, groupId: e.groupId, detectedAt: e.detectedAt, sectionIds: e.changedSections.map((c) => c.sectionId) }));
  const peerAligned: { peerId: string; groupId: string; detectedAt: string; alignments: Alignment[] }[] = [];
  // (group, article, section) -> peer -> best confidence among High/Medium
  const adoption = new Map<string, { groupId: string; articleKey: string; sectionId: string; peers: Map<string, Confidence> }>();
  if (input.diffs.length > 0) {
    for (const e of changed) {
      const pair = await input.load(e);
      if (!pair) continue;
      const alignments = alignEvent(e, pair.prev, pair.next, input);
      if (alignments.length === 0) continue;
      peerAligned.push({ peerId: e.peerId, groupId: e.groupId, detectedAt: e.detectedAt, alignments });
      if (!input.groups.get(e.groupId)?.peers.has(e.peerId)) continue;
      for (const a of alignments) {
        if (a.confidence === "low") continue;
        const key = `${e.groupId}|${a.articleKey}|${a.sectionId}`;
        const entry = adoption.get(key) ?? { groupId: e.groupId, articleKey: a.articleKey, sectionId: a.sectionId, peers: new Map<string, Confidence>() };
        const cur = entry.peers.get(e.peerId);
        if (!cur || RANK[a.confidence] > RANK[cur]) entry.peers.set(e.peerId, a.confidence);
        adoption.set(key, entry);
      }
    }
  }
  const groupAdoption: UrgencySignal[] = [];
  for (const g of adoption.values()) {
    const n = input.groups.get(g.groupId)?.n ?? 0;
    const k = g.peers.size;
    if (n === 0 || k < minK || k / n < minRatio) continue;
    groupAdoption.push(UrgencySignalSchema.parse({ articleKey: g.articleKey, sectionId: g.sectionId, groupId: g.groupId, k, n, windowDays, confidence: [...g.peers.values()].every((c) => c === "high") ? "high" : "medium", label: PEER_SIGNAL_LABEL }));
  }
  groupAdoption.sort((a, b) => a.groupId.localeCompare(b.groupId) || a.articleKey.localeCompare(b.articleKey) || a.sectionId.localeCompare(b.sectionId));
  return { peerChanged, peerAligned, groupAdoption };
}

/**
 * Attaches signals to Mode B findings whose section and trigger article match. Only `priority` and `evidence` are set: severity,
 * tier and every other field stay as they were, and a signal without a finding is dropped here (it never creates one).
 */
export function attachUrgencySignals(findings: readonly MonitorFinding[], signals: readonly UrgencySignal[]): MonitorFinding[] {
  return findings.map((f) => {
    if (f.mode !== "B" || !f.trigger) return f;
    const trigger = f.trigger;
    const hits = signals.filter((s) => s.sectionId === f.sectionId && refsRelated(s.articleKey, trigger.articleKey));
    return hits.length === 0 ? f : { ...f, priority: "raised" as const, evidence: hits.map((s) => ({ ...s })) };
  });
}
