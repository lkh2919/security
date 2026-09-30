/**
 * KB integrity: every committed knowledge-base file under kb/jurisdictions/kr parses with its contract schema,
 * and cross references (slots, rule items, clause variables, manifest hashes) resolve. No network, no raw sources.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { slotRegistryFromJson, type SlotRegistry } from "../src/contracts/common";
import { HouseStyleFileSchema } from "../src/contracts/house-style";
import { InterviewTemplateSchema, templateUnknownSlots } from "../src/contracts/interview-template";
import { KbClauseFileSchema, kbClauseProblems, kbClauseToRecord } from "../src/contracts/kb-clause";
import { ManifestSchema } from "../src/contracts/manifest";
import { RuleSectionSchema, RulePackIndexSchema, UnfairClauseLexiconSchema } from "../src/contracts/rulepack";
import { LawTargetsSchema, RetentionPeriodsSchema } from "../src/contracts/statutes";

const KR = join(import.meta.dir, "..", "..", "..", "kb", "jurisdictions", "kr");
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)])) : []);
const rel = (p: string): string => p.slice(KR.length + 1);

/**
 * Variables with no interview slot yet (Row 6b gap, tracked in docs/HANDOFF.md). They are document metadata
 * (announce date, version, table of contents) or need a new slot from the privacy-domain-expert (collection methods,
 * site URL, point policy, customer center). The test pins the list so a new unbound variable fails the build and
 * a newly bound one forces this list to shrink.
 */
const KNOWN_UNBOUND = [
  "lotte.privacy.S01.cross_group.03:tableOfContents",
  "lotte.privacy.S03.cross_group.02:collectionMethods",
  "lotte.privacy.S18.retail_ecommerce.01:customerCenter",
  "lotte.privacy.S24.cross_group.01:announceDate",
  "lotte.privacy.S24.cross_group.01:versionNumber",
  "lotte.privacy.S24.group_holding.01:announceDate",
  "lotte.privacy.S24.it_services.01:announceDate",
  "lotte.privacy.S24.it_services.01:versionNumber",
  "lotte.terms.T02.cross_group.01:siteUrl",
  "lotte.terms.T02.retail_ecommerce.01:pointPolicy",
  "lotte.terms.T07.retail_ecommerce.01:pointPolicy",
].sort();

const registry: SlotRegistry = slotRegistryFromJson(readJson(join(KR, "interview", "slots.json")));

describe("interview template", () => {
  test("template-v1 parses and only uses registered slots", () => {
    const template = InterviewTemplateSchema.parse(readJson(join(KR, "interview", "template-v1.json")));
    expect(templateUnknownSlots(template, registry)).toEqual([]);
  });
});

describe("rule packs", () => {
  for (const pack of ["privacy-2026.04", "terms-kftc-10023"]) {
    const dir = join(KR, "rulepacks", pack);
    test(`${pack}: index parses and lists existing section files`, () => {
      const index = RulePackIndexSchema.parse(readJson(join(dir, "index.json")));
      expect(index.packVersion).toBe(pack);
      for (const s of index.sections ?? []) expect(existsSync(join(dir, `${s.id}.json`))).toBe(true);
    });
    const sections = readdirSync(dir).filter((f) => /^[ST A]\w*\.json$/.test(f) && f !== "index.json" && !f.includes("lexicon"));
    test(`${pack}: has section files`, () => expect(sections.length).toBeGreaterThan(0));
    for (const f of sections) {
      test(`${pack}/${f} parses; rule ids unique; condition slots are registered`, () => {
        const section = RuleSectionSchema.parse(readJson(join(dir, f)));
        const ids = (section.rules ?? []).map((r) => r.ruleId);
        expect(new Set(ids).size).toBe(ids.length);
      });
    }
  }
  test("unfair clause lexicon parses", () => {
    UnfairClauseLexiconSchema.parse(readJson(join(KR, "rulepacks", "terms-kftc-10023", "unfair-clause-lexicon.json")));
  });
});

describe("statutes", () => {
  test("law-targets parses", () => void LawTargetsSchema.parse(readJson(join(KR, "statutes", "law-targets.json"))));
  test("retention-periods parses", () => void RetentionPeriodsSchema.parse(readJson(join(KR, "statutes", "retention-periods.json"))));
});

describe("clause library", () => {
  const files = walk(join(KR, "clauses")).filter((p) => /[\\/](privacy|terms)[\\/]/.test(p) && p.endsWith(".json"));
  test("has clause files", () => expect(files.length).toBeGreaterThan(0));
  const ids = new Set<string>();
  const unbound: string[] = [];
  for (const p of files) {
    test(`${rel(p)} parses, uses registered slots and only declared variables`, () => {
      const clause = KbClauseFileSchema.parse(readJson(p));
      expect(ids.has(clause.id)).toBe(false);
      ids.add(clause.id);
      const problems = kbClauseProblems(clause, registry);
      for (const pr of problems) {
        const m = pr.match(/^variable (\w+) has no slotId$/);
        if (m) unbound.push(`${clause.id}:${m[1]}`);
      }
      expect(problems.filter((pr) => !/has no slotId$/.test(pr))).toEqual([]);
      if (!problems.length) expect(() => kbClauseToRecord(clause)).not.toThrow();
    });
  }
  test("unbound variables match the pinned known gaps", () => expect(unbound.sort()).toEqual(KNOWN_UNBOUND));
  test("index count matches the files on disk", () => {
    const index = readJson(join(KR, "clauses", "index.json")) as { counts: { total: number } };
    expect(index.counts.total).toBe(files.length);
  });
});

describe("house style", () => {
  test("candidates parse and stay unapproved until the user approves", () => {
    const hs = HouseStyleFileSchema.parse(readJson(join(KR, "house-style", "lotte-innovate.candidates.json")));
    expect(hs.status).toBe("candidate");
    expect(existsSync(join(KR, "house-style", "lotte-innovate.json"))).toBe(false);
    for (const r of hs.rules) if (r.checkType === "regex") expect(() => new RegExp(r.pattern ?? "", "u")).not.toThrow();
  });
});

describe("manifest", () => {
  test("parses", () => void ManifestSchema.parse(readJson(join(KR, "manifest.json"))));
});
