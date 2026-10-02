/**
 * Dispatcher (design C3): one entry point per org config. Wires existing core entry points; no logic of its own.
 *
 *   bun scripts/agent.ts check  --config config/orgs/<org>/org.json [--llm api|claude-code|none] [--force]
 *   bun scripts/agent.ts impact --config ... --diff old.xml,new.xml --law PIPA [--effective YYYY-MM-DD] [--llm ...]
 *   bun scripts/agent.ts daily  --config ... [--llm ...] [--run-id daily-YYYYMMDD]
 *   bun scripts/agent.ts draft  --config ... --transcript interview.txt --form form.md [--masking basic] [--run-id ID] [--effective-date YYYY-MM-DD] [--llm ...]
 *   bun scripts/agent.ts peers  --config ... [--group retail] [--dry-run] [--limit N] [--with-lotte] | --export-baselines   (Peer Watch, see scripts/peers-cli.ts)
 *
 * `--llm` overrides the config's `llm`; `none` runs the deterministic part only. All outputs go under `runs/<tenantId>/...`
 * (`monitor/`, `daily/<runId>/`, `draft/<runId>/`). `daily` is resumable: rerun it (same day or `--run-id`) after a failed step and
 * finished steps are reused. It skips freshness with a note when LAW_GO_KR_OC is unset. Each run writes `usage.jsonl`.
 * Every output is a reference ("참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다.").
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LawApiClient, redactSecrets } from "../packages/core/src/adapters/lawapi";
import { PageWatcher } from "../packages/core/src/adapters/pages";
import { TextFileSttAdapter } from "../packages/core/src/adapters/stt";
import { loadOrgConfig, resolvePolicyDir, tenantPaths } from "../packages/core/src/config";
import type { OrgApp } from "../packages/core/src/contracts/org-config";
import { USAGE_FILE, appendUsageJsonl } from "../packages/core/src/llm/usage-log";
import { createBackendClient, resolveBackend, type BackendClient } from "../packages/core/src/llm/factory";
import { krPaths, loadKrKnowledge } from "../packages/core/src/stages/coverage";
import { runDaily } from "../packages/core/src/stages/daily";
import { loadRuleSections } from "../packages/core/src/stages/draft/load-sections";
import { loadFinanceLexicon, loadHeadingPatterns } from "../packages/core/src/stages/ingest";
import { ingestPolicyFolder, listPolicyFiles, runMonitorFolder } from "../packages/core/src/stages/monitor";
import { startRun } from "../packages/core/src/stages/orchestrate";
import { dailyPeersDeps, parsePeersArgs, runPeersCommand } from "./peers-cli";

const [command, ...rest] = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const fail = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};
const COMMANDS = ["check", "impact", "daily", "draft", "peers"] as const;
if (!command || !(COMMANDS as readonly string[]).includes(command)) fail("usage: bun scripts/agent.ts <check|impact|daily|draft|peers> --config config/orgs/<org>/org.json [--llm api|claude-code|none] (see the file header)");

const root = join(import.meta.dir, "..");
const configFile = opt("config");
if (!configFile) fail("missing --config config/orgs/<org>/org.json");
const org = loadOrgConfig(resolve(configFile!));
const tenant = tenantPaths(join(root, "runs"), org.tenantId);
const kr = join(root, "kb", "jurisdictions", "kr");

// apps gate: `daily` needs at least one of check, impact.
const needed: OrgApp[] = command === "daily" ? ["check", "impact"] : [command as OrgApp];
if (!needed.some((a) => org.apps.includes(a))) fail(`app "${command}" is not enabled for ${org.tenantId} (apps: ${org.apps.join(", ")})`);

if (command === "peers") {
  try {
    process.exit(await runPeersCommand(parsePeersArgs(root, rest)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

const llmChoice = opt("llm") ?? org.llm;
let backendClient: BackendClient | null = null;
if (llmChoice !== "none") {
  const backend = resolveBackend(llmChoice);
  backendClient = backend ? createBackendClient(backend) : null;
}
const backendNote = backendClient ? `model backend: ${backendClient.backend}` : "no model backend: deterministic checks only (org llm none, or set ANTHROPIC_API_KEY / pass --llm claude-code)";
console.log(`${org.tenantId}: ${command}; ${backendNote}`);
const llmDeps = backendClient ? { llm: backendClient.client, usage: backendClient } : {};
const policyDir = resolvePolicyDir(root, org);

async function monitor(withDiff: boolean): Promise<void> {
  if (!existsSync(policyDir)) fail(`policy folder not found: ${policyDir}`);
  if (listPolicyFiles(policyDir).length === 0) {
    console.log(`no policy files in ${policyDir}`);
    return;
  }
  const diffArg = opt("diff");
  const law = opt("law");
  if (withDiff && (!diffArg || diffArg.split(",").length !== 2 || !law)) fail("impact needs --diff old.xml,new.xml and --law <CODE>");
  const [oldPath, newPath] = diffArg ? (diffArg.split(",") as [string, string]) : ["", ""];
  const result = await runMonitorFolder({
    root,
    watchDir: policyDir,
    outRoot: tenant.monitorDir,
    registryPath: tenant.registryPath,
    backendNote,
    rulePacks: org.rulePacks,
    force: rest.includes("--force"),
    ...llmDeps,
    ...(withDiff ? { diff: { oldPath, newPath, law: law!, effective: opt("effective") ?? null } } : {}),
    log: (l) => console.log(l),
  });
  console.log(`reports: ${result.outDir}`);
}

async function daily(): Promise<void> {
  if (!existsSync(policyDir)) fail(`policy folder not found: ${policyDir}`);
  const now = new Date();
  const kb = loadKrKnowledge(krPaths(root, org.rulePacks[0]));
  const ruleSections = loadRuleSections(join(kr, "rulepacks"), org.rulePacks);
  const oc = process.env["LAW_GO_KR_OC"];
  const client = oc ? new LawApiClient({ oc }) : null;
  if (!client) console.log("LAW_GO_KR_OC is not set: the freshness step is skipped (steps b-d still run on what exists)");
  // Peer Watch step: on when the org enables the app and has a registry; `--skip-peers` turns it off for this run.
  const peers = org.apps.includes("peers") && !rest.includes("--skip-peers") ? dailyPeersDeps(root, resolve(configFile!), org.peersFile, tenant.peersDir) : null;
  if (org.apps.includes("peers") && !peers && !rest.includes("--skip-peers")) console.log("peers: no peer registry found (peersFile): the peers step is skipped");
  try {
    const r = await runDaily({
      krDir: kr,
      tenantId: tenant.tenantId,
      runsRoot: tenant.dailyDir,
      registryPath: tenant.registryPath,
      apps: { check: org.apps.includes("check"), impact: org.apps.includes("impact"), peers: peers !== null },
      ...(peers ? { peers: { ...peers.deps, financeLexicon: loadFinanceLexicon(root) } } : {}),
      loadPolicies: () => ingestPolicyFolder(root, policyDir, now),
      ruleSections,
      rulePackItems: kb.rulePackItems,
      rulePackVersion: kb.rulePackVersion,
      patterns: loadHeadingPatterns(root),
      titles: Object.fromEntries([...ruleSections].map(([id, s]) => [id, s.title.ko])),
      ...(client ? { lawApi: client, lawText: client, pages: new PageWatcher() } : {}),
      ...llmDeps,
      ...(opt("run-id") ? { runId: opt("run-id")! } : {}),
      now: () => now,
      log: (l) => console.log(redactSecrets(l, oc ? [oc] : [])),
    });
    for (const s of r.steps) console.log(`  ${s.stage}: ${s.resumed ? "reused" : "ran"}`);
    console.log(`digest: ${r.digestFile.replace(root, ".")}`);
  } catch (err) {
    console.error(redactSecrets(`daily chain stopped: ${err instanceof Error ? err.message : String(err)}\nFinished steps are kept; rerun the same command to resume at the failed step.`, oc ? [oc] : []));
    backendClient?.close();
    await peers?.close();
    process.exit(1);
  }
  await peers?.close();
}

async function draft(): Promise<void> {
  const transcriptFile = opt("transcript");
  const formFile = opt("form");
  if (!transcriptFile || !formFile) fail("draft needs --transcript interview.txt --form form.md (the draft pipeline is also available as scripts/run-pipeline.ts)");
  if (!backendClient) {
    console.log("skipped: draft needs a model backend (set ANTHROPIC_API_KEY, or use --llm claude-code)");
    return;
  }
  const masking = (opt("masking") ?? "off") as "off" | "basic";
  if (masking !== "off" && masking !== "basic") fail("--masking must be off or basic");
  const effectiveDate = opt("effective-date");
  if (effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) fail("--effective-date must be YYYY-MM-DD");
  const transcript = await new TextFileSttAdapter().transcribe(transcriptFile!);
  const form = await readFile(formFile!, "utf8");
  const o = await startRun({ llm: backendClient.client, runsRoot: tenant.draftDir, root }, { transcript, form, masking, ...(opt("run-id") ? { runId: opt("run-id") } : {}), ...(effectiveDate ? { effectiveDate } : {}) });
  if (o.status === "awaiting_answers") console.log(`awaiting answers: run ${o.runId}, round ${o.round}, ${o.questionSet.questions.length} question(s) (continue with scripts/run-pipeline.ts answer --runs-dir runs/${tenant.tenantId}/draft --run ${o.runId} ...)`);
  else console.log(`done: run ${o.runId}; verdicts ${Object.entries(o.verdicts).map(([d, v]) => `${d}=${v}`).join(" ")}`);
  await appendUsageJsonl(join(tenant.draftDir, o.runId, USAGE_FILE), backendClient.usageRecords());
}

if (command === "check") await monitor(false);
else if (command === "impact") await monitor(true);
else if (command === "daily") await daily();
else if (command === "draft") await draft();
backendClient?.close();
