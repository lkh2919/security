/** Loads rule-pack section files (`S01..S24`, `A1`, `T01..T15`) as parsed RuleSections, keyed by id. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RuleSectionSchema, type RuleSection } from "../../contracts/rulepack";

export function loadRuleSections(rulePacksDir: string, packs: readonly string[] = ["privacy-2026.04", "terms-kftc-10023"]): Map<string, RuleSection> {
  const out = new Map<string, RuleSection>();
  for (const pack of packs) {
    const dir = join(rulePacksDir, pack);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /^(S\d\d|T\d\d|A1)\.json$/.test(x)).sort()) {
      const sec = RuleSectionSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      out.set(sec.id, sec);
    }
  }
  return out;
}
