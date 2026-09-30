/** Loads rubric v1 and renders it as the static, cacheable part of the auditor system prompt. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RubricSchema, SCORE_DIMENSIONS, type Rubric } from "../../contracts/rubric";

export function loadRubric(krDir: string): Rubric {
  return RubricSchema.parse(JSON.parse(readFileSync(join(krDir, "rubric", "rubric-v1.json"), "utf8")));
}

/** Plain-text rubric for one profile. Stable text: no timestamps, sorted keys. */
export function renderRubric(rubric: Rubric, profile: "privacy" | "terms"): string {
  const p = rubric.profiles[profile];
  const lines: string[] = [`# RUBRIC ${rubric.version} (profile: ${profile})`, "", "## Principles"];
  for (const x of rubric.sharedLayer.principles) lines.push(`- ${x.id} ${x.name}: ${x.description}`);
  lines.push("", "## Score anchors (0-5)");
  for (const dim of SCORE_DIMENSIONS) {
    lines.push(`### ${dim}`);
    for (const k of ["0", "1", "2", "3", "4", "5"] as const) lines.push(`- ${k}: ${rubric.sharedLayer.scoreAnchors[dim][k]}`);
  }
  lines.push("", "## Severity guide");
  for (const [k, v] of Object.entries(rubric.sharedLayer.severityGuide)) lines.push(`- ${k}: ${v}`);
  lines.push("", "## House style", rubric.sharedLayer.houseStyleNote);
  lines.push("", `## ${profile} profile: extra checks`, ...p.extraChecks.map((c) => `- ${c}`));
  lines.push("", "## Cross-document checks", ...rubric.crossDocumentChecks.map((c) => `- ${c.id} ${c.name} (${c.defaultSeverity}): ${c.description}`));
  const r = rubric.passRule;
  lines.push("", "## Pass rule", `Pass needs ${r.maxBlocker} blockers, ${r.maxMajor} majors, every C2 check passing, every score >= ${r.minScore} (clarity >= ${r.minClarityScore}). Code computes the verdict; you only score and report findings.`);
  return lines.join("\n");
}
