/**
 * R6 freshness check runner (CLI-less). Run from the project root so Bun loads .env (LAW_GO_KR_OC).
 *   bun scripts/freshness-check.ts
 * Exit codes: 0 fresh, 10 drift warnings, 1 error. The OC key is never printed or written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LawApiClient, redactSecrets } from "../packages/core/src/adapters/lawapi";
import { PageWatcher } from "../packages/core/src/adapters/pages";
import { ManifestSchema, type Manifest } from "../packages/core/src/contracts/manifest";
import {
  DEFAULT_FRESHNESS_TARGETS,
  buildBaselineStamp,
  loadRuleIndex,
  runFreshnessDetailed,
  type LawApiPort,
  type PagePort,
} from "../packages/core/src/stages/freshness";

const root = resolve(import.meta.dir, "..");
const kr = join(root, "kb", "jurisdictions", "kr");
const oc = process.env["LAW_GO_KR_OC"];
const known = oc ? [oc] : [];
const say = (s: string): void => console.log(redactSecrets(s, known));

function placeholderManifest(now: Date): Manifest {
  return {
    manifestVersion: "0.0.0-placeholder",
    rulePacks: [],
    lawSnapshot: { id: "none", laws: [] },
    clauseLib: { version: "0.0.0", capturedAt: now.toISOString(), sites: [], vettedClauses: 0 },
    houseStyle: { version: "0.0.0" },
    pages: [],
  };
}

function loadManifest(): Manifest | null {
  const file = join(kr, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success || parsed.data.lawSnapshot.laws.length === 0) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Memoises port calls so a baseline pass and the comparison pass share one set of requests. */
function memo<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (...a: A) => {
    const k = JSON.stringify(a.map((x) => (typeof x === "object" && x !== null && "url" in x ? (x as { url: string }).url : x)));
    if (!cache.has(k)) cache.set(k, fn(...a));
    return cache.get(k)!;
  };
}

async function main(): Promise<number> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  if (!oc) {
    say("[ERROR] LAW_GO_KR_OC is not set. Run from the project root with .env present. / 환경변수 LAW_GO_KR_OC 없음");
    return 1;
  }
  const client = new LawApiClient({ oc });
  const api: LawApiPort = {
    getCurrentVersion: memo((n, t) => client.getCurrentVersion(n, t)),
    listScheduledVersions: memo((id) => client.listScheduledVersions(id)),
  };
  const watcher = new PageWatcher();
  const pages: PagePort = { snapshot: memo((t) => watcher.snapshot(t)) };
  const ruleIndex = loadRuleIndex(join(kr, "rulepacks"));

  let manifest = loadManifest();
  let baselineNote = "";
  if (!manifest) {
    const probe = await runFreshnessDetailed(placeholderManifest(now), DEFAULT_FRESHNESS_TARGETS, { lawApi: api, pages, ruleIndex, now: () => now });
    const stamp = buildBaselineStamp(probe.observed, now);
    manifest = { ...placeholderManifest(now), ...stamp };
    const dir = join(root, "runs", "_freshness");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `baseline-${date}.json`);
    writeFileSync(file, JSON.stringify(stamp, null, 2) + "\n", "utf8");
    baselineNote = `kb manifest.json missing/placeholder: baseline stamp written to runs/_freshness/baseline-${date}.json (kb untouched). / kb 매니페스트 없음: 기준값을 runs/_freshness에 기록`;
  }

  const result = await runFreshnessDetailed(manifest, DEFAULT_FRESHNESS_TARGETS, { lawApi: api, pages, ruleIndex, now: () => now });
  const { report, changes, observed } = result;

  const dir = join(root, "runs", "_freshness");
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const outFile = join(dir, `freshness-${stamp}.json`);
  writeFileSync(outFile, redactSecrets(JSON.stringify({ report, changes }, null, 2), known) + "\n", "utf8");

  say(`== Freshness ${date} / 최신성 점검: ${report.status.toUpperCase()} ==`);
  if (baselineNote) say(baselineNote);
  for (const [id, v] of Object.entries(observed.laws)) {
    say(`- ${id}: ${v.name} MST ${v.mst}, 공포 ${v.promulgatedOn} 제${v.promulgationNo}호, 시행 ${v.effectiveOn}, ${v.revisionType}`);
  }
  for (const [id, p] of Object.entries(observed.pages)) {
    say(`- ${id}: ${p.ok ? `ok, edition ${p.latestEdition ?? "n/a"}, ${p.items.length} item(s): ${p.items.map((i) => `${i.id} ${i.title}${i.attachment ? ` [${i.attachment}]` : ""}`).join(" | ").slice(0, 200)}` : `${p.problem} (${p.detail ?? ""})`}`);
  }
  for (const c of changes) say(`[${c.severity}] ${c.kind}: ${c.message}`);
  say(`affected sections: ${report.affectedSections.map((s) => s.itemId).join(",") || "none"}`);
  say(`report: ${outFile.replace(root, ".")}`);

  if (report.status === "unverified") return 1;
  return report.status === "drift" || changes.some((c) => c.severity === "warn") ? 10 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    say(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
