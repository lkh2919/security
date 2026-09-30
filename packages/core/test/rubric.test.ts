/**
 * Rubric v1 and seeded defects D1-D8: schema, cross references to the rule packs, and golden base cases.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DefectSpecSchema, RubricSchema } from "../src/contracts/rubric";
import { RuleSectionSchema, UnfairClauseLexiconSchema } from "../src/contracts/rulepack";

const ROOT = join(import.meta.dir, "..", "..", "..");
const KR = join(ROOT, "kb", "jurisdictions", "kr");
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

const sections = new Map<string, ReturnType<typeof RuleSectionSchema.parse>>();
for (const pack of ["privacy-2026.04", "terms-kftc-10023"]) {
  const dir = join(KR, "rulepacks", pack);
  for (const f of readdirSync(dir).filter((x) => /^(S\d\d|T\d\d|A1)\.json$/.test(x))) {
    const s = RuleSectionSchema.parse(readJson(join(dir, f)));
    sections.set(s.id, s);
  }
}
const ruleIds = new Set([...sections.values()].flatMap((s) => s.rules.map((r) => r.ruleId)));
const lexicon = UnfairClauseLexiconSchema.parse(readJson(join(KR, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json")));
const lexiconIds = new Set((lexicon.entries ?? []).map((e: { id: string }) => e.id));

const rubric = RubricSchema.parse(readJson(join(KR, "rubric", "rubric-v1.json")));
const defects = readdirSync(join(ROOT, "golden", "defects")).filter((f) => /^D\d\.json$/.test(f)).sort().map((f) => DefectSpecSchema.parse(readJson(join(ROOT, "golden", "defects", f))));

describe("rubric v1", () => {
  test("pass rule matches design R6.4", () => {
    expect(rubric.passRule).toEqual({ maxBlocker: 0, maxMajor: 0, minScore: 4, minClarityScore: 3, c2MustPass: true });
  });

  test("profiles cover every rule-pack section and only reference existing rules", () => {
    const priv = rubric.profiles.privacy.sectionChecks.map((c) => c.sectionId);
    const terms = rubric.profiles.terms.sectionChecks.map((c) => c.sectionId);
    expect(priv).toEqual([...sections.keys()].filter((id) => !id.startsWith("T")).sort((a, b) => priv.indexOf(a) - priv.indexOf(b)));
    expect(terms).toHaveLength(15);
    for (const c of [...rubric.profiles.privacy.sectionChecks, ...rubric.profiles.terms.sectionChecks]) {
      const real = sections.get(c.sectionId)!;
      expect(c.mustRuleIds).toEqual(real.rules.filter((r) => r.level === "must").map((r) => r.ruleId));
      expect(c.shouldRuleIds).toEqual(real.rules.filter((r) => r.level === "should").map((r) => r.ruleId));
    }
    expect(existsSync(join(ROOT, rubric.profiles.terms.unfairClauseLexicon))).toBe(true);
  });

  test("the four cross-document checks are the ones in design R6.1", () => {
    expect(rubric.crossDocumentChecks.map((c) => c.id)).toEqual(["X-01", "X-02", "X-03", "X-04"]);
  });

  test("rule-pack versions match the committed packs", () => {
    const manifest = readJson(join(KR, "manifest.json")) as { rulePacks: { id: string }[] };
    expect(rubric.rulePackVersions.sort()).toEqual(manifest.rulePacks.map((p) => p.id).sort());
  });
});

describe("seeded defects", () => {
  test("D1-D8 all exist and match the rubric list", () => {
    expect(defects.map((d) => d.id)).toEqual(rubric.seededDefects);
  });

  test("each defect maps to exactly one rule and one expected finding", () => {
    const seen = new Set<string>();
    for (const d of defects) {
      const key = `${d.expected.ruleId}@${d.expected.sectionId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      const knownRule = ruleIds.has(d.expected.ruleId) || lexiconIds.has(d.expected.ruleId) || rubric.crossDocumentChecks.some((c) => c.id === d.expected.ruleId);
      expect(knownRule).toBe(true);
      expect(d.expected.docType).toBe(d.docType);
    }
  });

  test("a rule-pack defect points at a section and a rule of that section", () => {
    for (const d of defects.filter((x) => x.docType !== "cross")) {
      const sec = sections.get(d.sectionId);
      expect(sec).toBeDefined();
      expect(sec!.rules.map((r) => r.ruleId)).toContain(d.expected.ruleId);
    }
  });

  test("every cited source is a legal ref of the rule it is seeded against (no unsourced law fact)", () => {
    for (const d of defects) {
      const sec = sections.get(d.sectionId)!;
      const rule = sec.rules.find((r) => r.ruleId === d.expected.ruleId);
      const allowed = new Set([...(rule?.legalRefs ?? []), ...sec.rules.flatMap((r) => r.legalRefs)]);
      for (const s of d.sources) expect(allowed.has(s)).toBe(true);
    }
  });

  test("base cases exist in the golden set", () => {
    for (const d of defects) expect(existsSync(join(ROOT, "golden", "cases", d.baseCase, "expected.json"))).toBe(true);
  });

  test("class coverage from design R6.3 is present", () => {
    const classes = defects.map((d) => d.defectClass).join(" | ");
    for (const needle of ["missing retention basis", "wrong recipient", "blanket liability exclusion", "wrong citation"]) expect(classes).toContain(needle);
  });

  test("the blanket exclusion defect text really hits the unfair-clause lexicon", () => {
    const d6 = defects.find((d) => d.id === "D6")!;
    const entry = (lexicon.entries ?? []).find((e: { id: string }) => e.id === "U-ARTC7-01") as { pattern: string };
    expect(new RegExp(entry.pattern, "u").test(d6.mutation.defectiveText ?? "")).toBe(true);
  });
});
