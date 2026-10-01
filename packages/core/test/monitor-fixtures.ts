/** Shared setup for the Policy Monitor tests: KB, patterns, fixture policies. Synthetic data only (placeholders). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IngestedPolicy } from "../src/contracts/ingested-policy";
import { krPaths, loadKrKnowledge } from "../src/stages/coverage";
import { loadRuleSections } from "../src/stages/draft/load-sections";
import { ingestPolicy, loadHeadingPatterns } from "../src/stages/ingest";

export const ROOT = join(import.meta.dir, "..", "..", "..");
export const MON_RUN_ID = "monitor-test-001";
export const NOW = new Date("2026-10-02T09:00:00.000Z");
export const patterns = loadHeadingPatterns(ROOT);
export const kb = loadKrKnowledge(krPaths(ROOT));
export const ruleSections = loadRuleSections(join(ROOT, "kb", "jurisdictions", "kr", "rulepacks"), ["privacy-2026.04"]);

export const fixturePath = (name: string): string => join(import.meta.dir, "fixtures", "monitor", name);
export const readFixture = (name: string): string => readFileSync(fixturePath(name), "utf8");

export function ingestFixture(name: string, policyId?: string): IngestedPolicy {
  return ingestPolicy({ name, content: readFixture(name), fetchedAt: NOW, ...(policyId ? { policyId } : {}) }, patterns);
}
