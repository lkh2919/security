/**
 * Peer Watch run (design C5): fetch each target through the safe fetcher, normalize, compare with the last snapshot, store a snapshot
 * only when the content changed, append change events, compute the signals and write the Korean report.
 *
 * `watchPeers` is the library entry point (C4 packaging); `scripts/agent.ts peers` and the `daily` chain call it. Everything external
 * is injected: the page fetcher (no network in tests), the fetch state, the clock.
 *
 * Dry run: pages are fetched and compared and the summary is returned, but no snapshot, change log, validator or report is written.
 * The fetch itself is real, so it still counts against the host's one-page-per-day limit.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { atomicWriteFile } from "../../pipeline/fs-atomic";
import type { AmendmentDiff } from "../../contracts/amendment-diff";
import type { PeerRegistry, PolicySnapshot, PolicyChangeEvent } from "../../contracts/peers";
import type { RuleSection } from "../../contracts/rulepack";
import type { PageFetcher } from "../../adapters/fetch/safe-fetch";
import type { FetchStateStore } from "../../adapters/fetch/state";
import type { HeadingPatterns } from "../ingest/segment-policy";
import { appendChangeLog, buildChangeEvent, readChangeLog } from "./changes";
import { sha256Hex } from "../../pipeline/canonical";
import { normalizePolicyHtml, type NormalizedPolicy } from "./normalize";
import { buildTargets, type CaptureEntry, type PeerTarget } from "./registry";
import { formatOutcomeLine, renderPeerReport, type PeerOutcome } from "./report";
import { SnapshotStore } from "./snapshots";
import { computeSignals, type PeerGroupInfo, type PeerSignals } from "./signals";

export interface WatchPeersInput {
  readonly registry: PeerRegistry;
  readonly captures: readonly CaptureEntry[];
  readonly fetcher: PageFetcher;
  readonly state: FetchStateStore;
  readonly patterns: HeadingPatterns;
  /** `runs/<tenant>/peers` */
  readonly peersDir: string;
  readonly tenantId: string;
  readonly group?: string;
  readonly limit?: number;
  /** Default true. */
  readonly includeLotte?: boolean;
  readonly dryRun?: boolean;
  readonly now?: () => Date;
  /** Recent amendments for P1 / P2. Without them only P0 (changes) is computed. */
  readonly amendmentDiffs?: readonly AmendmentDiff[];
  readonly ruleSections?: ReadonlyMap<string, RuleSection>;
  readonly lawNames?: (prefix: string) => readonly string[];
  /** Lotte capture that is new or changed: `html` is the fetched page (Mode A re-check input). */
  readonly onLotteChange?: (target: PeerTarget, html: string, change: "baseline" | "changed") => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface WatchPeersResult {
  readonly date: string;
  readonly dryRun: boolean;
  readonly outcomes: readonly PeerOutcome[];
  readonly events: readonly PolicyChangeEvent[];
  readonly signals: PeerSignals;
  readonly report: string;
  /** Absent in a dry run. */
  readonly reportFile?: string;
  readonly prunedSnapshots: number;
}

const EMPTY_SIGNALS: PeerSignals = { peerChanged: [], peerAligned: [], groupAdoption: [] };

export const peersPaths = (peersDir: string) => ({ snapshots: join(peersDir, "snapshots"), changelog: join(peersDir, "changelog.jsonl"), fetchState: join(peersDir, "fetch-state.json") });

export async function watchPeers(input: WatchPeersInput): Promise<WatchPeersResult> {
  const now = input.now ?? (() => new Date());
  const log = input.log ?? (() => undefined);
  const dryRun = input.dryRun === true;
  const paths = peersPaths(input.peersDir);
  const store = new SnapshotStore(paths.snapshots);
  const startedAt = now();
  const date = startedAt.toISOString().slice(0, 10);
  const { targets, skipped } = buildTargets(input.registry, input.captures, { ...(input.group ? { group: input.group } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}), ...(input.includeLotte === false ? { includeLotte: false } : {}) });

  const outcomes: PeerOutcome[] = skipped.map((s) => ({ id: s.id, groupId: s.groupId, name: s.name, kind: s.kind, status: "skipped", reason: s.reason }));
  const events: PolicyChangeEvent[] = [];
  const current = new Map<string, NormalizedPolicy>();

  for (const t of targets) {
    const base = { id: t.id, groupId: t.groupId, name: t.name, kind: t.kind };
    let outcome: PeerOutcome;
    try {
      outcome = await processTarget(t, base);
    } catch (err) {
      outcome = { ...base, status: "failed", reason: `error: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}` };
    }
    outcomes.push(outcome);
    log(formatOutcomeLine(outcome));
  }
  for (const s of skipped) log(formatOutcomeLine({ id: s.id, groupId: s.groupId, name: s.name, kind: s.kind, status: "skipped", reason: s.reason }));

  async function processTarget(t: PeerTarget, base: Pick<PeerOutcome, "id" | "groupId" | "name" | "kind">): Promise<PeerOutcome> {
    const prior = input.state.url(t.url);
    const res = await input.fetcher.fetchPage({ url: t.url, render: t.render });
    if (res.status === "skipped") return { ...base, status: "skipped", reason: res.reason };
    if (res.status === "failed") return { ...base, status: "failed", reason: res.reason };
    if (res.status === "not_modified") return { ...base, status: "unchanged" };

    const norm = normalizePolicyHtml(res.body, input.patterns);
    // Fail closed: a shell page is excluded from the counts and sent to manual review, never stored as an empty policy.
    if (norm.unusable) return { ...base, status: "skipped", reason: `manual_review: ${norm.unusable}` };
    const next = norm.policy;
    current.set(t.id, next);
    const rawSha = sha256Hex(res.body);
    const stored = await store.latest(t.id);
    const at = now();
    const writeSnapshot = async (): Promise<void> => {
      const snapshot: PolicySnapshot = {
        peerId: t.id,
        url: t.url,
        fetchedAt: at.toISOString(),
        contentSha256: next.contentSha256,
        sections: next.sections.map((s) => ({ sectionId: s.sectionId, sha256: s.sha256, charCount: s.charCount })),
        render: res.rendered ? "browser" : "html",
        status: "ok",
      };
      await store.write(snapshot, next.text);
    };
    const remember = (): void => {
      if (!dryRun) input.state.setUrl(t.url, { ...input.state.url(t.url), rawSha256: rawSha });
    };

    if (!stored) {
      if (!dryRun) await writeSnapshot();
      remember();
      if (t.kind === "lotte") await input.onLotteChange?.(t, res.body, "baseline");
      return { ...base, status: "baseline" };
    }
    const event = buildChangeEvent({ peerId: t.id, groupId: t.groupId, detectedAt: at, prev: stored.policy, next, rawChanged: prior.rawSha256 !== undefined && prior.rawSha256 !== rawSha });
    remember();
    if (!event) return { ...base, status: "unchanged" };
    events.push(event);
    if (event.cosmeticOnly) return { ...base, status: "cosmetic" };
    if (!dryRun) {
      await writeSnapshot();
      await appendChangeLog(paths.changelog, event);
    }
    if (t.kind === "lotte") await input.onLotteChange?.(t, res.body, "changed");
    return { ...base, status: "changed", changedSections: event.changedSections };
  }

  if (!dryRun) await input.state.flush();
  const prunedSnapshots = dryRun ? 0 : await store.prune(startedAt);

  // Signals: window events from the log (plus this run's, which a dry run has not logged).
  let signals = EMPTY_SIGNALS;
  const diffs = input.amendmentDiffs ?? [];
  if (diffs.length > 0) {
    const logged = readChangeLog(paths.changelog);
    const seen = new Set(logged.map((e) => `${e.peerId}|${e.toSha}|${e.detectedAt}`));
    const all = [...logged, ...events.filter((e) => !e.cosmeticOnly && !seen.has(`${e.peerId}|${e.toSha}|${e.detectedAt}`))];
    const groups = new Map<string, PeerGroupInfo>();
    for (const g of input.registry.groups) {
      const peers = g.peers.filter((p) => p.status === "active");
      let n = 0;
      for (const p of peers) if (current.has(p.peerId) || (await store.hasSnapshot(p.peerId))) n++;
      groups.set(g.groupId, { peers: new Set(peers.map((p) => p.peerId)), n });
    }
    signals = await computeSignals({
      events: all,
      groups,
      diffs,
      asOf: startedAt,
      ...(input.ruleSections ? { ruleSections: input.ruleSections } : {}),
      ...(input.lawNames ? { lawNames: input.lawNames } : {}),
      load: async (e) => {
        const cur = current.get(e.peerId);
        const next = cur && cur.contentSha256 === e.toSha ? cur : await store.findBySha(e.peerId, e.toSha);
        return next ? { prev: await store.findBySha(e.peerId, e.fromSha), next } : null;
      },
    });
  }

  const report = renderPeerReport({ date, tenantId: input.tenantId, dryRun, registry: input.registry, outcomes, signals });
  let reportFile: string | undefined;
  if (!dryRun) {
    // A second run on the same day keeps the first report (most hosts are skipped by the daily limit then): report-<date>-2.md, ...
    let n = 1;
    while (existsSync((reportFile = join(input.peersDir, n === 1 ? `report-${date}.md` : `report-${date}-${n}.md`)))) n++;
    await mkdir(input.peersDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(reportFile, report);
    await chmod(reportFile, 0o600).catch(() => undefined);
  }
  return { date, dryRun, outcomes, events, signals, report, ...(reportFile ? { reportFile } : {}), prunedSnapshots };
}
