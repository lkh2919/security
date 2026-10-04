/**
 * Mode B, amendment impact (Policy Monitor design M2-M5): which registered policies, which sections, must change because of an amendment?
 *
 *  1. Each changed 항/호 unit is matched to rule-pack rules whose `legalRefs` are equal to, a prefix of, or a child of the unit key.
 *     A change in `PIPA:30(1)1` reaches rules citing `PIPA:30(1)1`, `PIPA:30(1)` and `PIPA:30`, but a change in `PIPA:30(1)2`
 *     does not reach a rule that cites only `PIPA:30(1)1`. Units no rule cites are reported once as `UNMAPPED` (Confirm).
 *  2. For every (policy, affected section) one M1 call gets the old and new provision, the matched rules and the section text
 *     (fenced as untrusted): `still_compliant | must_change | review`, a verbatim quote and a suggested wording.
 *  3. Tier is `provisional` unless the caller passes `confirmed` (the domain expert verified the amendment). A provisional finding is
 *     worded as possible impact, capped at Medium, and its suggested wording is never final. A quote that is not verbatim is
 *     cleared and the finding drops to Confirm.
 *
 * Units whose law prefix the legal-ref map marks `manualReview` (finance, design C6) skip steps 1-3: they yield one Confirm finding per
 * policy labelled "금융 법령 해당 – 수동 검토", with no suggested wording and no model call.
 *
 * Without an LLM client the deterministic part runs: affected sections become Confirm findings that say the judgement was skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AmendmentDiff, AmendmentUnit } from "../../contracts/amendment-diff";
import { UNMAPPED_SECTION, type IngestedPolicy } from "../../contracts/ingested-policy";
import type { MonitorFinding, MonitorSeverity, MonitorTier } from "../../contracts/monitor-report";
import type { LegalRefMap } from "../../contracts/legalref-map";
import type { Rule, RuleSection } from "../../contracts/rulepack";
import type { LlmClient } from "../../llm/client";
import { loadPromptFile, type PromptFile } from "../extract/prompt";
import { isManualReviewPrefix } from "./legalref-map";
import { FINANCE_MANUAL_LABEL, UNTRUSTED_POLICY_NOTICE, capSeverity, clean, daysUntil, digestRules, fenceText, numberFindings, paraOfQuote, sectionModelText, verifyVerbatimQuote } from "./common";

export const IMPACT_PROMPT_PATH = "monitor/impact-v1.md";

export const ImpactJudgeSchema = z.strictObject({
  verdict: z.enum(["still_compliant", "must_change", "review"]),
  quote: z.string(),
  suggestedWording: z.string(),
});
export type ImpactJudgeOutput = z.infer<typeof ImpactJudgeSchema>;

// --- legal-ref matching --------------------------------------------------------------------------

const KEY = /^([A-Z][A-Z0-9-]*):(\d+)(?:-(\d+))?((?:\(\d+(?:-\d+)?\)|\[\d+(?:-\d+)?\])*)(\d+)?(?:-(\d+))?$/;

export interface ParsedRef {
  readonly law: string;
  /** `a38`, `a28-8`, `p1`, `i3-2`: article, paragraph and item levels in order. */
  readonly segments: readonly string[];
}

export function parseLegalRef(key: string): ParsedRef | null {
  const m = KEY.exec(key);
  if (!m) return null;
  const segments = [`a${m[2]}${m[3] ? `-${m[3]}` : ""}`];
  for (const part of m[4]!.match(/\(\d+(?:-\d+)?\)|\[\d+(?:-\d+)?\]/g) ?? []) segments.push(`${part.startsWith("(") ? "p" : "i"}${part.slice(1, -1)}`);
  if (m[5]) segments.push(`i${m[5]}${m[6] ? `-${m[6]}` : ""}`);
  return { law: m[1]!, segments };
}

/** Equal, ancestor or descendant (same law). Siblings are unrelated. */
export function refsRelated(a: string, b: string): boolean {
  const x = parseLegalRef(a);
  const y = parseLegalRef(b);
  if (!x || !y || x.law !== y.law) return false;
  const [short, long] = x.segments.length <= y.segments.length ? [x.segments, y.segments] : [y.segments, x.segments];
  return short.every((s, i) => long[i] === s);
}

export interface SectionImpact {
  readonly sectionId: string;
  readonly rules: readonly Rule[];
  readonly units: readonly AmendmentUnit[];
}

export interface ImpactMapping {
  readonly sections: readonly SectionImpact[];
  /** Units no rule cites. */
  readonly unmapped: readonly AmendmentUnit[];
}

export function mapUnitsToSections(units: readonly AmendmentUnit[], ruleSections: ReadonlyMap<string, RuleSection>): ImpactMapping {
  const bySection = new Map<string, { rules: Map<string, Rule>; units: Map<string, AmendmentUnit> }>();
  const unmapped: AmendmentUnit[] = [];
  for (const unit of units) {
    let hit = false;
    for (const [sectionId, section] of ruleSections) {
      for (const rule of section.rules) {
        if (!rule.legalRefs.some((ref) => refsRelated(ref, unit.key))) continue;
        hit = true;
        const entry = bySection.get(sectionId) ?? { rules: new Map(), units: new Map() };
        entry.rules.set(rule.ruleId, rule);
        entry.units.set(unit.key, unit);
        bySection.set(sectionId, entry);
      }
    }
    if (!hit) unmapped.push(unit);
  }
  return {
    sections: [...bySection.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sectionId, e]) => ({ sectionId, rules: [...e.rules.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId)), units: [...e.units.values()] })),
    unmapped,
  };
}

// --- runner --------------------------------------------------------------------------------------

export interface ImpactDeps {
  readonly llm?: LlmClient;
  readonly prompt?: PromptFile;
}

export interface ImpactInput {
  /** Reviewed wording-only units (default: kb/jurisdictions/kr/statutes/amendment-classes.json). */
  readonly terminologyOverrides?: readonly TerminologyOverride[];
  readonly diff: AmendmentDiff;
  readonly policies: readonly IngestedPolicy[];
  readonly ruleSections: ReadonlyMap<string, RuleSection>;
  /** True only after the domain expert verified the amendment and updated the rule pack (design M4). */
  readonly confirmed?: boolean;
  /** Prefix -> law (statutes/legalref-map.json). Absent or empty: every prefix is `mapped`. */
  readonly legalRefMap?: LegalRefMap;
  readonly now?: Date;
}

export interface ImpactResult {
  /** policyId -> findings (ids `B-0001`...). Policies with no finding are present with an empty list. */
  readonly perPolicy: ReadonlyMap<string, MonitorFinding[]>;
  /** Changed units no rule cites, reported once (not per policy). */
  readonly unmapped: MonitorFinding[];
  readonly adjustments: readonly string[];
  readonly warnings: readonly string[];
  readonly llmUsed: boolean;
}

type Draft = Omit<MonitorFinding, "id">;
const MAX_TEXT = 2000;

function impactUserTurn(impact: SectionImpact, section: RuleSection, text: string): string {
  const units = impact.units.map((u) => ({ key: u.key, change: u.change, oldText: u.oldText?.slice(0, MAX_TEXT), newText: u.newText?.slice(0, MAX_TEXT) }));
  const rules = digestRules(section, new Set(impact.rules.map((r) => r.ruleId)));
  return [
    `SECTION ${impact.sectionId}: ${section.title.ko}`,
    "AMENDED PROVISIONS (JSON, from the law text):",
    JSON.stringify(units),
    "RULES (JSON, trusted):",
    JSON.stringify(rules.map(({ ruleId, level, element, statement, legalRefs }) => ({ ruleId, level, element, statement, legalRefs }))),
    "SECTION TEXT (untrusted data):",
    fenceText(text),
  ].join("\n");
}

/** Severity of a must_change verdict (design M4): upcoming within 90 days Medium, later Low; in force High (Medium while provisional). */
export function impactSeverity(args: { hasMust: boolean; effectiveOn: string | null; now: Date; confirmed: boolean }): MonitorSeverity {
  if (args.effectiveOn !== null) {
    const days = daysUntil(args.effectiveOn, args.now);
    if (days > 0) return days <= 90 ? "medium" : "low";
  }
  if (!args.hasMust) return "low";
  return args.confirmed ? "high" : "medium";
}

const LAW_KO: Readonly<Record<string, string>> = { PIPA: "개인정보 보호법", DEC: "개인정보 보호법 시행령", NETA: "정보통신망법", "NETA-DEC": "정보통신망법 시행령", CIA: "신용정보법", EFTA: "전자금융거래법", FCPA: "금융소비자보호법" };
const CHANGE_KO: Readonly<Record<string, string>> = { amended: "개정", added: "신설", deleted: "삭제" };

/** "PIPA:31(1)", "PIPA:31(3)2", "PIPA:31(4)" ... -> "제31조 제1항, 제3항~제4항": one entry per article, items folded into their paragraph. */
export function compactUnitKeys(keys: readonly string[]): string {
  const byArticle = new Map<string, Set<number>>();
  for (const k of keys) {
    const m = /^[A-Z-]+:(\d+(?:-\d+)?)(?:\((\d+)\))?/.exec(k);
    if (!m) continue;
    const set = byArticle.get(m[1]!) ?? new Set<number>();
    if (m[2]) set.add(Number(m[2]));
    byArticle.set(m[1]!, set);
  }
  return [...byArticle]
    .map(([art, paras]) => {
      const name = `제${art.replace(/-(\d+)$/, "조의$1").replace(/^(\d+)$/, "$1조")}`;
      if (paras.size === 0) return name;
      const sorted = [...paras].sort((a, b) => a - b);
      const runs: string[] = [];
      for (let i = 0; i < sorted.length; i++) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
        runs.push(j > i + 1 ? `제${sorted[i]}항~제${sorted[j]}항` : j === i + 1 ? `제${sorted[i]}항, 제${sorted[j]}항` : `제${sorted[i]}항`);
        i = j;
      }
      return `${name} ${runs.join(", ")}`;
    })
    .join("; ");
}

// --- terminology-only changes (domain self-review 2026-10-03, §10.5 #1-2) -------------------------------------------------

/** The 2026 PIPA amendment replaced the six-word harm list with the defined term 유출등 throughout the Act. */
const HARM_LIST = /분실\s*[ㆍ·]\s*도난\s*[ㆍ·]\s*유출\s*[ㆍ·]\s*위조\s*[ㆍ·]\s*변조\s*또는\s*훼손/g;

/** Text with amendment-history tags, the 유출등 swap and cross-reference numbers neutralized; spaces and punctuation dropped. */
export function normalizeForTerminology(text: string): string {
  return text
    .replace(/<(?:개정|신설|본조신설|전문개정|삭제)[^>]*>/g, "")
    .replace(HARM_LIST, "유출등")
    .replace(/유출등(?:이)?\s*되지\s*(?:아니하|않)도록/g, "유출등방지")
    .replace(/(?:되지\s*(?:아니하|않)도록)/g, "")
    .replace(/제\d+조(?:의\d+)?(?:제\d+항)?(?:제\d+호)?(?:부터)?/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export interface TerminologyOverride {
  readonly key: string;
  readonly newTextSha256: string;
}

/** Reviewed wording-only units the normalization cannot see (`kb/jurisdictions/kr/statutes/amendment-classes.json`). */
export function loadAmendmentClasses(repoRoot: string): TerminologyOverride[] {
  const file = join(repoRoot, "kb", "jurisdictions", "kr", "statutes", "amendment-classes.json");
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, "utf8")) as { terminology?: TerminologyOverride[] };
  return doc.terminology ?? [];
}

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");

/** An amended unit whose text differs only by terminology or renumbering. Added and deleted units are always substantive. */
export function isTerminologyUnit(u: AmendmentUnit, overrides: readonly TerminologyOverride[]): boolean {
  if (u.change !== "amended" || u.oldText === undefined || u.newText === undefined) return false;
  const sha = createHash("sha256").update(u.newText).digest("hex");
  if (overrides.some((o) => o.key === u.key && o.newTextSha256 === sha)) return true;
  return normalizeForTerminology(u.oldText) === normalizeForTerminology(u.newText);
}

export async function runImpact(deps: ImpactDeps, input: ImpactInput): Promise<ImpactResult> {
  const now = input.now ?? new Date();
  const confirmed = input.confirmed === true;
  const tier: MonitorTier = confirmed ? "confirmed" : "provisional";
  const { diff } = input;
  const legalRefMap = input.legalRefMap ?? {};
  const isManual = (u: AmendmentUnit): boolean => {
    const law = parseLegalRef(u.key)?.law;
    return law !== undefined && isManualReviewPrefix(legalRefMap, law);
  };
  const manualUnits = diff.units.filter(isManual);
  // Terminology-only units are listed once per run and never alert per policy (no policy wording depends on them).
  const overrides = input.terminologyOverrides ?? loadAmendmentClasses(REPO_ROOT);
  const terminologyUnits = diff.units.filter((u) => !isManual(u) && isTerminologyUnit(u, overrides));
  const mapping = mapUnitsToSections(diff.units.filter((u) => !isManual(u) && !terminologyUnits.includes(u)), input.ruleSections);
  const adjustments: string[] = [];
  const warnings: string[] = [];
  const perPolicy = new Map<string, MonitorFinding[]>();
  let llmUsed = false;
  const prompt = deps.llm ? (deps.prompt ?? loadPromptFile(IMPACT_PROMPT_PATH)) : null;
  if (!deps.llm) warnings.push("LLM backend not used: affected sections are listed without a model judgement");

  const trigger = (key: string): NonNullable<MonitorFinding["trigger"]> => ({ law: diff.law, articleKey: key, effectiveOn: diff.effectiveOn });
  const lawKo = LAW_KO[diff.law] ?? diff.law;
  const when = diff.effectiveOn ? `${diff.effectiveOn} 시행` : "시행일 미정";
  const wording = tier === "provisional" ? `${lawKo} 개정(${when})으로 이 항목의 수정이 필요할 수 있습니다 (미검증).` : `${lawKo} 개정(${when})으로 이 항목의 수정이 필요합니다.`;

  const unmapped = numberFindings(
    "BU",
    [
      ...terminologyUnits.map(
        (u): Draft => ({ mode: "B", tier: "provisional", layer: "deterministic", ruleId: "MON-TERMINOLOGY", sectionId: UNMAPPED_SECTION, severity: "confirm", message: `개정 조문 ${u.key}: 용어(유출등) 또는 인용 조문 번호만 바뀌었습니다. 처리방침 수정이 필요 없는 변경으로 보고 처리방침별 알림을 보내지 않습니다 (참고).`, fixHint: "", location: { sectionId: UNMAPPED_SECTION, para: null, quote: "" }, trigger: trigger(u.key) }),
      ),
      ...mapping.unmapped.map(
      (u): Draft => ({ mode: "B", tier: "provisional", layer: "deterministic", ruleId: "MON-UNMAPPED", sectionId: UNMAPPED_SECTION, severity: "confirm", message: `개정 조문 ${u.key}(${CHANGE_KO[u.change] ?? u.change})은(는) 현재 규칙 팩의 어느 규칙과도 연결되지 않습니다. 처리방침에 미치는 영향은 도메인 검토가 필요합니다.`, fixHint: "정보보호실·법무 검토 후 규칙 팩 반영 여부를 결정하십시오.", location: { sectionId: UNMAPPED_SECTION, para: null, quote: "" }, trigger: trigger(u.key) }),
    ),
    ]
  );

  // One finding per (policy, change) for finance units: no suggested wording (empty fixHint), no model call.
  const manualDraft = (): Draft => ({
    mode: "B",
    tier: "provisional",
    layer: "deterministic",
    ruleId: "MON-FINANCE-MANUAL",
    sectionId: UNMAPPED_SECTION,
    severity: "confirm",
    message: `${FINANCE_MANUAL_LABEL}: ${diff.law} 개정 조문(${manualUnits.slice(0, 5).map((u) => u.key).join(", ")}${manualUnits.length > 5 ? " 외" : ""})은 금융 법령 개정입니다. 규칙 팩으로 자동 판단하지 않으며 사람이 영향을 검토해야 합니다.`,
    fixHint: "",
    location: { sectionId: UNMAPPED_SECTION, para: null, quote: "" },
    trigger: trigger(manualUnits[0]!.key),
  });

  for (const policy of input.policies) {
    const drafts: Draft[] = manualUnits.length > 0 ? [manualDraft()] : [];
    perPolicy.set(policy.policyId, numberFindings("B", drafts));
    if (mapping.sections.length === 0) continue;
    if (policy.status !== "ok") {
      const first = mapping.sections[0]!.units[0]!;
      drafts.push({ mode: "B", tier: "provisional", layer: "deterministic", ruleId: "MON-INGEST", sectionId: UNMAPPED_SECTION, severity: "confirm", message: "처리방침 문서를 자동으로 분석하지 못해 개정 영향을 판단하지 못했습니다. 사람이 검토해야 합니다.", fixHint: "지원되는 형식(Markdown, HTML)으로 다시 제출하거나 수동으로 검토하십시오.", location: { sectionId: UNMAPPED_SECTION, para: null, quote: "" }, trigger: trigger(first.key) });
      perPolicy.set(policy.policyId, numberFindings("B", drafts));
      continue;
    }
    for (const impact of mapping.sections) {
      const section = input.ruleSections.get(impact.sectionId)!;
      const keys = impact.units.map((u) => u.key);
      const primary = [...impact.rules].sort((a, b) => Number(b.level === "must") - Number(a.level === "must") || a.ruleId.localeCompare(b.ruleId))[0]!;
      const others = impact.rules.filter((r) => r.ruleId !== primary.ruleId).map((r) => r.ruleId);
      const relatedNote = others.length ? ` 관련 규칙: ${others.join(", ")}.` : "";
      const base = { mode: "B" as const, tier, ruleId: primary.ruleId, sectionId: impact.sectionId, trigger: trigger(keys[0]!) };
      const { paras, sent, text } = sectionModelText(policy, impact.sectionId);

      if (paras.length === 0) {
        // A conditional section (가명정보 S13, 국내대리인 S19 ...) that the policy does not have is no question for this amendment.
        if (section.classification !== "mandatory") {
          adjustments.push(`${policy.policyId} ${impact.sectionId}: conditional section not in the policy, no amendment question`);
          continue;
        }
        drafts.push({ ...base, layer: "deterministic", severity: "confirm", message: `개정 범위(${compactUnitKeys(keys)})에 연결된 ${impact.sectionId}(${section.title.ko}) 항목을 처리방침에서 찾지 못했습니다. 해당 항목이 필요한지 확인하십시오.${relatedNote}`, fixHint: "처리방침에 해당 항목이 있는지, 개정으로 새로 필요한지 검토하십시오.", location: { sectionId: impact.sectionId, para: null, quote: "" } });
        continue;
      }
      if (sent.length === 0) {
        drafts.push({ ...base, layer: "deterministic", severity: "confirm", message: `${FINANCE_MANUAL_LABEL}: 개정 범위(${compactUnitKeys(keys)})에 연결된 ${impact.sectionId}(${section.title.ko}) 항목이 모두 금융 법령 관련 내용이라 모델에 보내지 않았습니다. 사람이 검토해야 합니다.${relatedNote}`, fixHint: "해당 항목을 개정 내용과 대조해 검토하십시오.", location: { sectionId: impact.sectionId, para: null, quote: "" } });
        continue;
      }
      if (!deps.llm || !prompt) {
        drafts.push({ ...base, layer: "deterministic", severity: "confirm", message: `개정 범위(${compactUnitKeys(keys)})이 ${impact.sectionId}(${section.title.ko})의 규칙과 연결됩니다. 모델 판단을 실행하지 않아 영향 여부는 확인되지 않았습니다.${relatedNote}`, fixHint: "해당 항목을 개정 내용과 대조해 검토하십시오.", location: { sectionId: impact.sectionId, para: null, quote: "" } });
        continue;
      }

      llmUsed = true;
      let out: ImpactJudgeOutput;
      try {
        const res = await deps.llm.callStructured({ stageId: "M1", system: `${prompt.body}\n\n${UNTRUSTED_POLICY_NOTICE}`, user: impactUserTurn(impact, section, text), schema: ImpactJudgeSchema, schemaName: "MonitorImpactJudge", promptVersion: prompt.version });
        out = res.data;
      } catch (err) {
        warnings.push(`${policy.policyId} ${impact.sectionId}: the model judgement failed (${err instanceof Error ? err.name : "error"}); manual review required`);
        drafts.push({ ...base, layer: "llm", severity: "confirm", message: `개정 범위(${compactUnitKeys(keys)})의 영향을 ${impact.sectionId}(${section.title.ko})에서 자동으로 판단하지 못했습니다. 사람이 검토해야 합니다.${relatedNote}`, fixHint: "해당 항목을 수동으로 확인하십시오.", location: { sectionId: impact.sectionId, para: null, quote: "" } });
        continue;
      }
      if (out.verdict === "still_compliant") continue;

      let quote = verifyVerbatimQuote(text, out.quote);
      let severity: MonitorSeverity;
      if (out.verdict === "review") severity = "confirm";
      else severity = impactSeverity({ hasMust: impact.rules.some((r) => r.level === "must"), effectiveOn: diff.effectiveOn, now, confirmed });
      if (quote === null) {
        adjustments.push(`${policy.policyId} ${impact.sectionId}: quote is not verbatim; cleared and downgraded to confirm`);
        quote = "";
        severity = "confirm";
      }
      if (tier === "provisional") severity = capSeverity(severity, "medium");
      const suggestion = clean(out.suggestedWording).trim();
      const fixHint = suggestion ? (tier === "provisional" ? `(참고 문안, 확정 아님) ${suggestion}` : suggestion) : "해당 문단을 개정 내용에 맞게 검토하십시오.";
      const message = out.verdict === "review" ? `${lawKo} 개정 범위(${compactUnitKeys(keys)})가 ${impact.sectionId}(${section.title.ko})에 영향을 주는지 확인이 필요합니다.${relatedNote}` : `${wording} 개정 범위: ${compactUnitKeys(keys)}.${relatedNote}`;
      drafts.push({ ...base, layer: "llm", severity, message, fixHint, location: { sectionId: impact.sectionId, para: paraOfQuote(paras, quote), quote } });
    }
    perPolicy.set(policy.policyId, numberFindings("B", drafts));
  }
  return { perPolicy, unmapped, adjustments, warnings, llmUsed };
}
