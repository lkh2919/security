/**
 * Shared body of `bun scripts/agent.ts peers` and `bun scripts/peer-watch.ts` (design C5, C3).
 *
 *   --config config/orgs/<org>/org.json   org pack; its `peersFile` (relative to the config folder) is the peer registry
 *   --group <groupId>                     one group (default: the org's domainGroup when it names a group, else all)
 *   --limit N                             fetch at most N pages
 *   --dry-run                             fetch and compare, write nothing (no snapshot, change log, validator or report);
 *                                         the fetch itself still counts against each host's one page per UTC day
 *   --export-baselines                    migration: write the hash-only baselines (kb/.../peers/baselines/<peerId>.json, committed to git)
 *                                         from the local snapshots under runs/<tenant>/peers/snapshots; fetches nothing
 *   --with-lotte                          dry run only: also fetch the group's Lotte captures. Lotte captures are re-checked
 *                                         (Mode A) by `daily`, never by this command, so a real run leaves them alone.
 *
 * Fetching follows the safe-fetch rules: exact registry URLs, robots.txt, honest user agent, one page per host per day.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { FileFetchState, PlaywrightBrowserFetcher, SafeFetcher } from "../packages/core/src/adapters/fetch";
import { loadOrgConfig, tenantPaths } from "../packages/core/src/config";
import { loadHeadingPatterns } from "../packages/core/src/stages/ingest";
import { BaselineStore, SnapshotStore, exportBaselines, loadCaptureIndex, loadPeerRegistry, peersPaths, watchPeers } from "../packages/core/src/stages/peers";

export const DEFAULT_REGISTRY = join("kb", "jurisdictions", "kr", "monitor", "peers", "peer-registry.json");
export const CAPTURE_INDEX = join("kb", "jurisdictions", "kr", "clauses", "_captures", "index.json");

export function registryFileOf(root: string, configFile: string, peersFile: string | undefined): string {
  if (!peersFile) return join(root, DEFAULT_REGISTRY);
  return isAbsolute(peersFile) ? peersFile : resolve(dirname(resolve(configFile)), peersFile);
}

/** Committed baselines live next to the registry. */
export const baselinesDirOf = (registryFile: string): string => join(dirname(registryFile), "baselines");

export interface PeersCliArgs {
  readonly root: string;
  readonly configFile: string;
  readonly group?: string;
  readonly limit?: number;
  readonly dryRun: boolean;
  readonly withLotte: boolean;
  readonly exportBaselines: boolean;
}

/** Parses `--group`, `--limit`, `--dry-run`, `--with-lotte` from an argv tail. Throws a usage message on bad input. */
export function parsePeersArgs(root: string, argv: readonly string[]): PeersCliArgs {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const configFile = opt("config");
  if (!configFile) throw new Error("missing --config config/orgs/<org>/org.json");
  const limitRaw = opt("limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new Error("--limit must be a non-negative integer");
  const dryRun = argv.includes("--dry-run");
  const withLotte = argv.includes("--with-lotte");
  if (withLotte && !dryRun) throw new Error("--with-lotte is only available with --dry-run: Lotte captures are re-checked by the daily chain (agent.ts daily)");
  const group = opt("group");
  const exportBaselines = argv.includes("--export-baselines");
  return { root, configFile, dryRun, withLotte, exportBaselines, ...(group ? { group } : {}), ...(limit !== undefined ? { limit } : {}) };
}

export async function runPeersCommand(args: PeersCliArgs, log: (line: string) => void = console.log): Promise<number> {
  const org = loadOrgConfig(resolve(args.configFile));
  const tenant = tenantPaths(join(args.root, "runs"), org.tenantId);
  const registryFile = registryFileOf(args.root, args.configFile, org.peersFile);
  if (!existsSync(registryFile)) throw new Error(`peer registry not found: ${registryFile} (set peersFile in the org config)`);
  const registry = loadPeerRegistry(registryFile);
  const group = args.group ?? (registry.groups.some((g) => g.groupId === org.domainGroup) ? org.domainGroup : undefined);
  const captures = loadCaptureIndex(join(args.root, CAPTURE_INDEX));
  const paths = peersPaths(tenant.peersDir);
  const baselinesDir = baselinesDirOf(registryFile);

  if (args.exportBaselines) {
    const snapshots = new SnapshotStore(paths.snapshots);
    const r = await exportBaselines(snapshots, new BaselineStore(baselinesDir), await snapshots.peerIds());
    log(`${org.tenantId}: export-baselines -> ${baselinesDir.replace(args.root, ".")}: ${r.written.length} written, ${r.unchanged.length} already current${r.missing.length ? `, ${r.missing.length} without snapshot` : ""}`);
    return 0;
  }

  const state = new FileFetchState(paths.fetchState);
  const browser = new PlaywrightBrowserFetcher();
  const fetcher = new SafeFetcher({ state, browser, persistValidators: !args.dryRun });
  log(`${org.tenantId}: peers${group ? ` (group ${group})` : " (all groups)"}${args.dryRun ? ", dry run: nothing is written" : ""}; registry ${registry.version}`);
  try {
    const r = await watchPeers({
      registry,
      captures,
      fetcher,
      state,
      patterns: loadHeadingPatterns(args.root),
      peersDir: tenant.peersDir,
      baselinesDir,
      tenantId: tenant.tenantId,
      ...(group ? { group } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      includeLotte: args.withLotte,
      dryRun: args.dryRun,
      log,
    });
    const count = (s: string): number => r.outcomes.filter((o) => o.status === s).length;
    log(`summary: ${r.outcomes.length} target(s): ${count("unchanged")} unchanged, ${count("baseline")} first snapshot, ${count("changed")} changed, ${count("cosmetic")} cosmetic-only, ${count("skipped")} skipped, ${count("failed")} failed`);
    if (r.signals.groupAdoption.length > 0) for (const s of r.signals.groupAdoption) log(`signal: ${s.groupId} ${s.articleKey} ${s.sectionId} ${s.k}/${s.n} (${s.label})`);
    if (r.reportFile) log(`report: ${r.reportFile.replace(args.root, ".")}`);
    if (r.prunedSnapshots > 0) log(`pruned ${r.prunedSnapshots} snapshot(s) older than 90 days`);
    return 0;
  } finally {
    await browser.close();
  }
}

/** Builds the `daily` chain's peers input from the org config; null when the org has no usable registry. */
export function dailyPeersDeps(root: string, configFile: string, peersFile: string | undefined, peersDir: string) {
  const registryFile = registryFileOf(root, configFile, peersFile);
  if (!existsSync(registryFile)) return null;
  const state = new FileFetchState(peersDir ? peersPaths(peersDir).fetchState : "");
  const browser = new PlaywrightBrowserFetcher();
  return { deps: { registry: loadPeerRegistry(registryFile), captures: loadCaptureIndex(join(root, CAPTURE_INDEX)), fetcher: new SafeFetcher({ state, browser }), state, peersDir, baselinesDir: baselinesDirOf(registryFile) }, close: () => browser.close() };
}
