/**
 * Org config packs and tenant paths (design C4). `loadOrgConfig` reads `config/orgs/<org>/org.json`; the tenant helpers prefix every
 * run, registry, watch and report path with the tenant id (`runs/<tenantId>/...`, default tenant "default").
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_TENANT_ID, OrgConfigSchema, TenantIdSchema, type OrgConfig } from "../contracts/org-config";

export function loadOrgConfig(file: string): OrgConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`[ORG_CONFIG] ${file} is not readable JSON: ${err instanceof Error ? err.message.slice(0, 160) : "error"}`);
  }
  const r = OrgConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`[ORG_CONFIG] ${file} is invalid: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** `config/orgs/<org>/org.json` under the repository root. */
export const orgConfigPath = (repoRoot: string, org: string): string => join(repoRoot, "config", "orgs", org, "org.json");

/** Policy folder of an org: absolute as written, else relative to the repository root. */
export const resolvePolicyDir = (repoRoot: string, org: OrgConfig): string => (isAbsolute(org.policyDir) ? org.policyDir : resolve(repoRoot, org.policyDir));

export interface TenantPaths {
  readonly tenantId: string;
  /** `<runsRoot>/<tenantId>` */
  readonly root: string;
  /** Mode A/B reports and the watch registry: `<root>/monitor` (registry at `<root>/monitor/registry.json`). */
  readonly monitorDir: string;
  readonly registryPath: string;
  /** Daily chain runs: `<root>/daily/<runId>`. */
  readonly dailyDir: string;
  /** Freshness reports and baseline stamps. */
  readonly freshnessDir: string;
  /** Draft pipeline runs. */
  readonly draftDir: string;
}

/** `runsRoot` is `<repo>/runs`. The tenant id is validated: it becomes a directory name. */
export function tenantPaths(runsRoot: string, tenantId: string = DEFAULT_TENANT_ID): TenantPaths {
  const id = TenantIdSchema.parse(tenantId);
  const root = join(runsRoot, id);
  const monitorDir = join(root, "monitor");
  return { tenantId: id, root, monitorDir, registryPath: join(monitorDir, "registry.json"), dailyDir: join(root, "daily"), freshnessDir: join(root, "freshness"), draftDir: join(root, "draft") };
}
