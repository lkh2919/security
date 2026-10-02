/**
 * Watch registry (Policy Monitor design M5): `runs/monitor/registry.json`. SHA-256 change detection: an unchanged hash skips Mode A.
 * Load and save are the only I/O; everything else is a pure function over `WatchRegistry`. A corrupt file is an error, not an empty
 * registry: silently starting over would re-alert (or hide) every policy.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../../pipeline/fs-atomic";
import { EMPTY_REGISTRY, WatchRegistrySchema, type WatchEntry, type WatchRegistry } from "../../contracts/watch-registry";
import type { IngestedPolicy } from "../../contracts/ingested-policy";
import type { MonitorReport } from "../../contracts/monitor-report";

/** Legacy single-tenant location; the tenant-prefixed path is `tenantPaths(runsRoot, tenantId).registryPath`. */
export const REGISTRY_RELATIVE_PATH = join("runs", "monitor", "registry.json");

export function loadRegistry(path: string): WatchRegistry {
  if (!existsSync(path)) return EMPTY_REGISTRY;
  try {
    return WatchRegistrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new Error(`[MONITOR_REGISTRY] ${path} is not a valid registry (${err instanceof Error ? err.message.slice(0, 200) : "error"}); fix or remove it`);
  }
}

export async function saveRegistry(path: string, registry: WatchRegistry): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(WatchRegistrySchema.parse(registry), null, 2)}\n`);
}

export type ChangeState = "new" | "changed" | "unchanged";

export function detectChange(registry: WatchRegistry, policyId: string, sha256: string): ChangeState {
  const entry = registry.policies[policyId];
  if (!entry) return "new";
  return entry.sha256 === sha256 ? "unchanged" : "changed";
}

/** Records a check of `policy` (and its report, when one was written). Returns a new registry. */
export function recordCheck(registry: WatchRegistry, policy: IngestedPolicy, now: Date, report?: { report: MonitorReport; file?: string }): WatchRegistry {
  const prev = registry.policies[policy.policyId];
  const at = now.toISOString();
  const entry: WatchEntry = {
    policyId: policy.policyId,
    source: { ...(policy.source.path ? { path: policy.source.path } : {}), ...(policy.source.url ? { url: policy.source.url } : {}), format: policy.source.format },
    sha256: policy.source.sha256,
    firstSeenAt: prev?.firstSeenAt ?? at,
    lastCheckedAt: at,
    ...(report ? { lastReport: { runId: report.report.runId, checkedAt: report.report.checkedAt, summary: report.report.summary, ...(report.file ? { file: report.file } : {}) } } : prev?.lastReport ? { lastReport: prev.lastReport } : {}),
  };
  return { version: 1, updatedAt: at, policies: { ...registry.policies, [policy.policyId]: entry } };
}
