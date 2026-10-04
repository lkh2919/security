/**
 * Historical Peer Watch (design C5, user decision "compare historical policy versions").
 *
 *   bun scripts/peer-history.ts [--config config/orgs/example/org.json] [--group retail] [--law PIPA --old-mst <mst> --new-mst <mst>]
 *                               [--effective YYYY-MM-DD] [--since YYYY-MM-DD]
 *
 * For each active peer whose registry entry has a `history` ({ versions, beforeAmendment, afterAmendment }), fetches the policy version in
 * force before and after the amendment (http or browser; `form` versions are skipped with a reason), normalizes, segments and masks both
 * like the daily watch, builds the change event and computes P1 / P2 against the AmendmentDiff of the given law versions. Peers without
 * history or without an update across the amendment are counted separately ("이력 미공개", "개정 전후 갱신 없음").
 *
 * Law versions: LAW_GO_KR_OC (environment only, never written to a file) is used for lawSearch/lawService. Without --old-mst the previous
 * version is the one promulgated before --new-mst in the version list `lawSearch target=eflaw&LID=<법령ID>&nw=1,2,3`. Defaults: --law PIPA,
 * --new-mst 283839 (개인정보 보호법, 공포 2026-03-10, 공포번호 21445, 시행 2026-09-11; previous MST 270351), --since = its promulgation date.
 *
 * History fetches use their own fetch state (`runs/<tenant>/peers/history-fetch-state.json`): they do not use up the current-policy
 * one-page-per-day slot, robots.txt and back-off still apply, and at most 3 history pages are requested per host per run. Browser
 * fetches honour PEER_BROWSER_CA_FILE like the daily watch.
 *
 * Version fetch modes in the registry `history.versions[]`: `http`, `browser`, `form` (skipped), `anchor` (one page fetch; the element of the URL #fragment or `selector`)
 * and `select` (browser: choose `select` {selector, value}, wait for the content, extract `contentSelector`). A before text equal to the after text is
 * reported as `failed: same_text`, never as "compared, 0 changes".
 *
 * Output: `runs/<tenant>/peers/history-<law>-<date>.md` (Korean) and `.json`. Reference only: no rating, no ranking.
 */
import { existsSync } from "node:fs";
import { mkdir, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileFetchState, PlaywrightBrowserFetcher, SafeFetcher } from "../packages/core/src/adapters/fetch";
import { LawApiClient } from "../packages/core/src/adapters/lawapi";
import { loadOrgConfig, tenantPaths } from "../packages/core/src/config";
import { atomicWriteFile } from "../packages/core/src/pipeline/fs-atomic";
import { loadRuleSections } from "../packages/core/src/stages/draft/load-sections";
import { loadHeadingPatterns } from "../packages/core/src/stages/ingest";
import { loadLegalRefMap } from "../packages/core/src/stages/monitor/legalref-map";
import { collapseAlignments, comparePeerHistory, detailList, loadPeerRegistry, peersPaths, refLabel, renderHistoryReport, resolveAmendment, splitArticleKey } from "../packages/core/src/stages/peers";
import { registryFileOf } from "./peers-cli";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = join(import.meta.dir, "..");
const fail = (m: string): never => {
  console.error(m);
  process.exit(2);
};

const DEFAULT_NEW_MST: Record<string, string> = { PIPA: "283839" };

const configFile = resolve(opt("config") ?? join(root, "config", "orgs", "example", "org.json"));
const org = loadOrgConfig(configFile);
const tenant = tenantPaths(join(root, "runs"), org.tenantId);
const registryFile = registryFileOf(root, configFile, org.peersFile);
if (!existsSync(registryFile)) fail(`peer registry not found: ${registryFile}`);
const registry = loadPeerRegistry(registryFile);
const kr = join(root, "kb", "jurisdictions", "kr");
const law = opt("law") ?? "PIPA";
const entry = loadLegalRefMap(kr)[law];
if (!entry?.lawId) fail(`unknown law prefix "${law}" in statutes/legalref-map.json (or it has no lawId)`);
const newMst = opt("new-mst") ?? DEFAULT_NEW_MST[law] ?? entry!.currentMst;
if (!newMst) fail(`--new-mst is required for ${law}`);
const oc = process.env["LAW_GO_KR_OC"];
if (!oc) fail("LAW_GO_KR_OC is not set (environment only; it is never written to a file)");
const client = new LawApiClient({ oc });

/** One entry per article and section (the 항/호 units in a parenthesis; k is the largest k among them). */
const consoleSignals = (signals: readonly { articleKey: string; sectionId: string; k: number; n: number; confidence: "high" | "medium" | "low" }[]): string =>
  collapseAlignments(signals)
    .map((c) => {
      const mine = signals.filter((s) => s.sectionId === c.sectionId && splitArticleKey(s.articleKey).article === c.article);
      return `${refLabel(c.article, detailList(c.keys))} ${c.sectionId} ${Math.max(...mine.map((s) => s.k))}/${mine[0]!.n} ${c.confidence}`;
    })
    .join("; ");

const asOf = new Date();
const date = asOf.toISOString().slice(0, 10);
const log = (l: string): void => console.log(l);
const paths = peersPaths(tenant.peersDir);

const amendment = await resolveAmendment(client, { law, lawId: entry!.lawId!, newMst: newMst!, ...(opt("old-mst") ? { oldMst: opt("old-mst")! } : {}), ...(opt("effective") ? { effectiveOn: opt("effective")! } : {}) });
log(`${law}: MST ${amendment.oldMst} -> ${amendment.newMst}, effective ${amendment.diff.effectiveOn ?? "unknown"}, ${amendment.diff.units.length} unit(s) changed`);
log(`previous version: ${amendment.howFound}`);
const since = opt("since") ?? amendment.promulgatedOn;
if (!since) fail("--since YYYY-MM-DD is required (the promulgation date is unknown)");

const state = new FileFetchState(paths.historyFetchState);
const browser = new PlaywrightBrowserFetcher();
const fetcher = new SafeFetcher({ state, browser, persistValidators: false });
const ruleSections = loadRuleSections(join(kr, "rulepacks"), org.rulePacks);
try {
  const result = await comparePeerHistory({
    registry,
    ...(opt("group") ? { group: opt("group")! } : {}),
    fetcher,
    state,
    patterns: loadHeadingPatterns(root),
    diff: amendment.diff,
    windowStart: since!,
    asOf,
    ruleSections,
    lawNames: (prefix) => {
      const e = loadLegalRefMap(kr)[prefix];
      return e ? [e.lawNameKo, ...(e.aliases ?? [])] : [];
    },
    log,
  });
  await state.flush();
  const titles = Object.fromEntries([...ruleSections].map(([id, s]) => [id, s.title.ko]));
  const md = renderHistoryReport({ result, tenantId: tenant.tenantId, date, titles, amendment });
  await mkdir(tenant.peersDir, { recursive: true, mode: 0o700 });
  const base = join(tenant.peersDir, `history-${law}-${date}`);
  const json = { ...result, amendment: { oldMst: amendment.oldMst, newMst: amendment.newMst, promulgatedOn: amendment.promulgatedOn, promulgationNo: amendment.promulgationNo, howFound: amendment.howFound } };
  await atomicWriteFile(`${base}.md`, md);
  await atomicWriteFile(`${base}.json`, `${JSON.stringify(json, null, 2)}\n`);
  await Promise.all([chmod(`${base}.md`, 0o600), chmod(`${base}.json`, 0o600)]).catch(() => undefined);
  console.log("");
  console.log("group | active | n | changed | no_update | no_history | skipped/failed | k/n (article section conf)");
  for (const g of result.groups) console.log(`${g.groupId} | ${g.active} | ${g.compared} | ${g.changed} | ${g.noUpdate} | ${g.noHistory} | ${g.skipped + g.failed} | ${consoleSignals(g.signals) || "-"}`);
  console.log(`report: ${base.replace(root, ".")}.md / .json`);
} finally {
  await browser.close();
}
