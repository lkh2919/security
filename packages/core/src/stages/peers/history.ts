/**
 * Historical Peer Watch (design C5, user decision "compare historical policy versions"): for each peer whose registry entry has a
 * `history`, fetch the policy version in force before and after an amendment, normalize / segment / mask both the way the daily watch
 * does, build the change event between them and compute P1 / P2 against the AmendmentDiff of that amendment.
 *
 * Reference only: a peer change "co-occurred" with an amendment, it was not "caused by" it; no peer is rated or ranked (peers appear in
 * registry order). History fetches go through the same safe fetcher, but with their own fetch state: they never use up the
 * one-page-per-day slot of the current-policy watch, and at most `maxPagesPerHost` (3) history pages are requested per host per run.
 */
import type { AmendmentDiff } from "../../contracts/amendment-diff";
import { PEER_SIGNAL_LABEL, PeerHistorySchema, PeerHistoryVersionSchema, type PeerGroup, type PeerRegistry, type PolicyChangeEvent, type UrgencySignal } from "../../contracts/peers";
import type { RuleSection } from "../../contracts/rulepack";
import type { PageFetcher, SelectSpec } from "../../adapters/fetch/safe-fetch";
import type { FetchStateStore } from "../../adapters/fetch/state";
import type { HeadingPatterns } from "../ingest/segment-policy";
import { buildChangeEvent } from "./changes";
import { extractElementHtml, fragmentSelector, withoutFragment } from "./extract";
import { normalizePolicyHtml, type NormalizedPolicy } from "./normalize";
import { computeSignals, type Alignment, type PeerGroupInfo } from "./signals";

export const MAX_HISTORY_PAGES_PER_HOST = 3;
const DAY_MS = 86_400_000;

export type HistoryStatus = "compared" | "no_update" | "no_history" | "skipped" | "failed";

export interface HistoryPeerResult {
  readonly peerId: string;
  readonly groupId: string;
  readonly name: string;
  readonly status: HistoryStatus;
  readonly reason?: string;
  /** Effective dates of the compared versions. */
  readonly beforeDate?: string;
  readonly afterDate?: string;
  /** Present when both versions were compared (no change at all: `changedSections` is empty and `cosmeticOnly` false). */
  readonly changedSections?: PolicyChangeEvent["changedSections"];
  readonly cosmeticOnly?: boolean;
  readonly alignments?: readonly Alignment[];
}

export interface HistoryGroupSummary {
  readonly groupId: string;
  readonly nameKo: string;
  /** Active peers of the group in the registry. */
  readonly active: number;
  /** n: peers whose before and after versions were both fetched and usable. */
  readonly compared: number;
  /** Compared peers with at least one changed section (not cosmetic). */
  readonly changed: number;
  readonly noUpdate: number;
  readonly noHistory: number;
  readonly skipped: number;
  readonly failed: number;
  /** k/n per amended article and section; High and Medium alignments only. All shown, `meetsThreshold` marks k >= 3 and k/n >= 0.6. */
  readonly signals: readonly (UrgencySignal & { readonly meetsThreshold: boolean })[];
}

export interface HistoryResult {
  readonly label: typeof PEER_SIGNAL_LABEL;
  readonly law: string;
  readonly diff: { readonly oldVersion: string; readonly newVersion: string; readonly effectiveOn: string | null; readonly unitCount: number; readonly unitKeys: readonly string[] };
  readonly windowStart: string;
  readonly asOf: string;
  readonly peers: readonly HistoryPeerResult[];
  readonly groups: readonly HistoryGroupSummary[];
}

export interface HistoryInput {
  readonly registry: PeerRegistry;
  readonly group?: string;
  /** Fetcher with its own state (see `state`). */
  readonly fetcher: PageFetcher;
  /** The fetcher's state: its per-host day slot is released before each history page (the per-run limit below replaces it). */
  readonly state: FetchStateStore;
  readonly patterns: HeadingPatterns;
  readonly diff: AmendmentDiff;
  /** Promulgation date of the amendment (ISO): a peer version effective before it is outside the window. */
  readonly windowStart: string;
  readonly asOf: Date;
  readonly ruleSections?: ReadonlyMap<string, RuleSection>;
  readonly lawNames?: (prefix: string) => readonly string[];
  readonly maxPagesPerHost?: number;
  readonly log?: (line: string) => void;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-07-01`, `2026.7.1`, `2026년 7월 1일` -> ISO; null when it is none of these. */
export function isoDateOf(text: string): string | null {
  const t = text.trim();
  if (ISO.test(t)) return t;
  const m = /^(\d{4})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})\s*(?:일|\.)?$/.exec(t);
  return m ? `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` : null;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export async function comparePeerHistory(input: HistoryInput): Promise<HistoryResult> {
  const log = input.log ?? (() => undefined);
  const maxPerHost = input.maxPagesPerHost ?? MAX_HISTORY_PAGES_PER_HOST;
  const groups = input.group ? input.registry.groups.filter((g) => g.groupId === input.group) : input.registry.groups;
  if (input.group && groups.length === 0) throw new Error(`[PEER_REGISTRY] unknown group "${input.group}" (groups: ${input.registry.groups.map((g) => g.groupId).join(", ")})`);

  const perHost = new Map<string, number>();
  const pairs = new Map<string, { prev: NormalizedPolicy; next: NormalizedPolicy }>();
  const events: PolicyChangeEvent[] = [];
  const results: HistoryPeerResult[] = [];

  type Fetched = { ok: true; body: string } | { ok: false; status: "skipped" | "failed"; reason: string };
  type Version = ReturnType<typeof PeerHistoryVersionSchema.parse>;
  /** Pages already fetched in this run (an `anchor` page serves several versions with one request). */
  const pageCache = new Map<string, Promise<Fetched>>();

  /** Fetches one page through the safe fetcher under the per-host history limit. */
  async function fetchBody(url: string, render: "html" | "browser", select?: SelectSpec): Promise<Fetched> {
    const host = hostOf(url);
    const used = perHost.get(host) ?? 0;
    if (used >= maxPerHost) return { ok: false, status: "skipped", reason: `history_host_limit: ${maxPerHost} history pages per host per run` };
    perHost.set(host, used + 1);
    input.state.setHost(host, { lastPageDay: undefined });
    const res = await input.fetcher.fetchPage({ url, render, ...(select ? { select } : {}) });
    if (res.status === "skipped") return { ok: false, status: "skipped", reason: res.reason };
    if (res.status === "failed") return { ok: false, status: "failed", reason: res.reason };
    if (res.status === "not_modified") return { ok: false, status: "failed", reason: "unexpected not_modified" };
    return { ok: true, body: res.body };
  }

  function normalizeBody(html: string): { ok: true; policy: NormalizedPolicy } | { ok: false; status: "skipped"; reason: string } {
    const norm = normalizePolicyHtml(html, input.patterns);
    if (norm.unusable) return { ok: false, status: "skipped", reason: `manual_review: ${norm.unusable}` };
    return { ok: true, policy: norm.policy };
  }

  /** One version -> normalized policy, by its fetch mode (`http`, `browser`, `anchor`, `select`). */
  async function fetchVersion(v: Version): Promise<{ ok: true; policy: NormalizedPolicy } | { ok: false; status: "skipped" | "failed"; reason: string }> {
    if (v.fetch === "anchor") {
      const selector = v.selector ?? fragmentSelector(v.url);
      if (!selector) return { ok: false, status: "failed", reason: "anchor: the URL has no #fragment and the version has no selector" };
      const base = withoutFragment(v.url);
      let page = pageCache.get(base);
      if (!page) {
        page = fetchBody(base, "html");
        pageCache.set(base, page);
      }
      const got = await page;
      if (!got.ok) return got;
      const el = extractElementHtml(got.body, selector);
      if (el === null) return { ok: false, status: "failed", reason: `anchor: element "${selector}" not found in the page` };
      return normalizeBody(el);
    }
    if (v.fetch === "select") {
      if (!v.select || !v.contentSelector) return { ok: false, status: "failed", reason: "select: the version needs `select` {selector, value} and `contentSelector`" };
      const got = await fetchBody(withoutFragment(v.url), "browser", { selector: v.select.selector, value: v.select.value, contentSelector: v.contentSelector });
      return got.ok ? normalizeBody(got.body) : got;
    }
    const got = await fetchBody(v.url, v.fetch === "browser" ? "browser" : "html");
    return got.ok ? normalizeBody(got.body) : got;
  }

  async function processPeer(g: PeerGroup, p: PeerGroup["peers"][number]): Promise<HistoryPeerResult> {
    const base = { peerId: p.peerId, groupId: g.groupId, name: p.name };
    const parsed = PeerHistorySchema.safeParse((p as Record<string, unknown>)["history"]);
    if (!parsed.success) return { ...base, status: "no_history", reason: (p as Record<string, unknown>)["history"] === undefined ? "이력 미공개 (registry history 없음)" : "이력 미공개 (history 형식 오류)" };
    const h = parsed.data;
    if (h.versions.length === 0) return { ...base, status: "no_history", reason: h.note ? `이력 미공개: ${h.note}` : "이력 미공개" };
    const bi = h.beforeAmendment ?? null;
    const ai = h.afterAmendment ?? null;
    if (bi === null && ai === null) return { ...base, status: "no_history", reason: h.note ? `이력 미공개: ${h.note}` : "이력 미공개 (개정 전후 버전 미지정)" };
    if (bi === null) return { ...base, status: "no_history", reason: "이력 미공개 (개정 전 버전 없음)" };
    if (ai === null || ai === bi) return { ...base, status: "no_update", reason: h.note ? `개정 전후 갱신 없음: ${h.note}` : "개정 전후 갱신 없음" };
    const before = h.versions[bi];
    const after = h.versions[ai];
    if (!before || !after) return { ...base, status: "failed", reason: "history index out of range" };
    const bd = isoDateOf(before.effectiveDate);
    const ad = isoDateOf(after.effectiveDate);
    if (!bd || !ad) return { ...base, status: "failed", reason: "history effectiveDate is not a date" };
    for (const v of [before, after]) if (v.fetch === "form") return { ...base, status: "skipped", reason: `fetch_form: 양식 조회 필요, 자동 수집 안 함${v.formNote ? ` (${v.formNote})` : ""}`, beforeDate: bd, afterDate: ad };
    const b = await fetchVersion(before);
    if (!b.ok) return { ...base, status: b.status, reason: `before: ${b.reason}`, beforeDate: bd, afterDate: ad };
    const a = await fetchVersion(after);
    if (!a.ok) return { ...base, status: a.status, reason: `after: ${a.reason}`, beforeDate: bd, afterDate: ad };
    // A fetch that silently returned the current text for the old version is no evidence: never count it as "compared, 0 changes".
    if (a.policy.contentSha256 === b.policy.contentSha256) return { ...base, status: "failed", reason: "same_text: the before and after versions normalize to identical text (the old version was not really retrieved)", beforeDate: bd, afterDate: ad };
    // The change is dated by the day the new version took effect (that is the day compared with the amendment window).
    const event = buildChangeEvent({ peerId: p.peerId, groupId: g.groupId, detectedAt: new Date(`${ad}T00:00:00.000Z`), prev: b.policy, next: a.policy });
    const changedSections = event?.changedSections ?? [];
    if (event) {
      events.push(event);
      pairs.set(`${event.peerId}|${event.toSha}`, { prev: b.policy, next: a.policy });
    }
    return { ...base, status: "compared", beforeDate: bd, afterDate: ad, changedSections, cosmeticOnly: event?.cosmeticOnly ?? false };
  }

  for (const g of groups) {
    for (const p of g.peers) {
      if (p.status !== "active") continue;
      let r: HistoryPeerResult;
      try {
        r = await processPeer(g, p);
      } catch (err) {
        r = { peerId: p.peerId, groupId: g.groupId, name: p.name, status: "failed", reason: `error: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}` };
      }
      results.push(r);
      log(`${r.status.padEnd(9)} ${g.groupId}/${p.peerId}${r.reason ? ` (${r.reason})` : ""}`);
    }
  }

  // P1 / P2 over the events: window from the amendment's promulgation to `asOf`.
  const eff = input.diff.effectiveOn ? Date.parse(`${input.diff.effectiveOn}T00:00:00Z`) : null;
  const start = Date.parse(`${input.windowStart}T00:00:00Z`);
  const leadDays = eff !== null ? Math.max(0, Math.ceil((eff - start) / DAY_MS)) : undefined;
  const windowDays = Math.max(30, Math.ceil(((eff !== null ? input.asOf.getTime() - eff : input.asOf.getTime() - start)) / DAY_MS) + 1);
  const groupInfo = new Map<string, PeerGroupInfo>();
  for (const g of groups) {
    const peers = new Set(g.peers.filter((p) => p.status === "active").map((p) => p.peerId));
    groupInfo.set(g.groupId, { peers, n: results.filter((r) => r.groupId === g.groupId && r.status === "compared").length });
  }
  const signals = await computeSignals({
    events,
    groups: groupInfo,
    diffs: [input.diff],
    asOf: input.asOf,
    windowDays,
    ...(leadDays !== undefined ? { leadDays } : {}),
    minK: 1,
    minRatio: 0,
    ...(input.ruleSections ? { ruleSections: input.ruleSections } : {}),
    ...(input.lawNames ? { lawNames: input.lawNames } : {}),
    load: async (e) => pairs.get(`${e.peerId}|${e.toSha}`) ?? null,
  });

  const aligned = new Map(signals.peerAligned.map((a) => [a.peerId, a.alignments]));
  const peers = results.map((r) => (r.status === "compared" ? { ...r, alignments: aligned.get(r.peerId) ?? [] } : r));
  const summaries: HistoryGroupSummary[] = groups.map((g) => {
    const mine = peers.filter((r) => r.groupId === g.groupId);
    const count = (s: HistoryStatus): number => mine.filter((r) => r.status === s).length;
    const info = groupInfo.get(g.groupId)!;
    return {
      groupId: g.groupId,
      nameKo: g.nameKo,
      active: info.peers.size,
      compared: count("compared"),
      changed: mine.filter((r) => r.status === "compared" && !r.cosmeticOnly && (r.changedSections?.length ?? 0) > 0).length,
      noUpdate: count("no_update"),
      noHistory: count("no_history"),
      skipped: count("skipped"),
      failed: count("failed"),
      signals: signals.groupAdoption.filter((s) => s.groupId === g.groupId).map((s) => ({ ...s, meetsThreshold: s.k >= 3 && s.k / s.n >= 0.6 })),
    };
  });

  return {
    label: PEER_SIGNAL_LABEL,
    law: input.diff.law,
    diff: { oldVersion: input.diff.oldVersion, newVersion: input.diff.newVersion, effectiveOn: input.diff.effectiveOn, unitCount: input.diff.units.length, unitKeys: input.diff.units.map((u) => u.key) },
    windowStart: input.windowStart,
    asOf: input.asOf.toISOString(),
    peers,
    groups: summaries,
  };
}
