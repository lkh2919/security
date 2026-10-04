/**
 * Static demo dashboard builder. One self-contained HTML file (data embedded as JSON), no server, no network at view time.
 *
 *   bun scripts/build-dashboard.ts --config config/orgs/example/org.json [--out runs/<tenant>/dashboard/index.html] [--monitor-dir <stamp folder or folder of stamps>] [--impact-dir <Mode B run folder[,more]>]
 *
 * Reads run outputs under runs/<tenant>/ (monitor reports, peers history, usage.jsonl), runs/eval, runs/_freshness and the golden
 * amendment fixtures. Product zone: output goes under gitignored runs/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assembleDashboard, renderDashboardHtml } from "../apps/dashboard/assemble";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = join(import.meta.dir, "..");
const config = opt("config");
if (!config) {
  console.error("usage: bun scripts/build-dashboard.ts --config config/orgs/<org>/org.json [--out <file>] [--monitor-dir <dir>] [--impact-dir <dir[,dir]>]");
  process.exit(2);
}
const data = assembleDashboard({ root, configPath: resolve(config), ...(opt("monitor-dir") ? { monitorDir: opt("monitor-dir")! } : {}), ...(opt("impact-dir") ? { impactDir: opt("impact-dir")! } : {}) });
const out = resolve(opt("out") ?? join(root, "runs", String(data.meta.tenantId), "dashboard", "index.html"));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderDashboardHtml(join(root, "apps", "dashboard"), data), "utf8");
console.log(`dashboard: ${out}`);
console.log(`policies ${data.policies.length}, amendments ${data.amendments.length}, peers ${data.peers ? "yes" : "none"}, gates ${data.gates ? `${data.gates.pass}/${data.gates.total}` : "none"}`);
