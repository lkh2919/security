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
 * Without an LLM client the deterministic part runs: affected sections become Confirm findings that say the judgement was skipped.
 */
import { z } from "zod";
import type { AmendmentDiff, AmendmentUnit } from "../../contracts/amendment-diff";
import { UNMAPPED_SECTION, type IngestedPara, type IngestedPolicy } from "../../contracts/ingested-policy";
import type { MonitorFinding, MonitorSeverity, MonitorTier } from "../../contracts/monitor-report";
import type { Rule, RuleSection } from "../../contracts/rulepack";
import type { LlmClient } from "../../llm/client";
import { loadPromptFile, type PromptFile } from "../extract/prompt";
import { UNTRUSTED_POLICY_NOTICE, capSeverity, clean, daysUntil, digestRules, fenceText, numberFindings, paraOfQuote, verifyVerbatimQuote } from "./common";

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
  readonly diff: AmendmentDiff;
  readonly policies: readonly IngestedPolicy[];
  readonly ruleSections: ReadonlyMap<string, RuleSection>;
  /** True only after the domain expert verified the amendment and updated the rule pack (design M4). */
  readonly confirmed?: boolean;
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

function mergedParas(policy: IngestedPolicy, sectionId: string): IngestedPara[] {
  const out: IngestedPara[] = [];
  for (const s of policy.sections) if (s.sectionId === sectionId) for (const p of s.paras) out.push({ ...p, n: out.length + 1 });
  return out;
}

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

export async function runImpact(deps: ImpactDeps, input: ImpactInput): Promise<ImpactResult> {
  const now = input.now ?? new Date();
  const confirmed = input.confirmed === true;
  const tier: MonitorTier = confirmed ? "confirmed" : "provisional";
  const { diff } = input;
  const mapping = mapUnitsToSections(diff.units, input.ruleSections);
  const adjustments: string[] = [];
  const warnings: string[] = [];
  const perPolicy = new Map<string, MonitorFinding[]>();
  let llmUsed = false;
  const prompt = deps.llm ? (deps.prompt ?? loadPromptFile(IMPACT_PROMPT_PATH)) : null;
  if (!deps.llm) warnings.push("LLM backend not used: affected sections are listed without a model judgement");

  const trigger = (key: string): NonNullable<MonitorFinding["trigger"]> => ({ law: diff.law, articleKey: key, effectiveOn: diff.effectiveOn });
  const wording = tier === "provisional" ? "개정으로 인해 변경이 필요할 수 있습니다(가능성, 미검증)." : "개정으로 인해 변경이 필요합니다.";

  const unmapped = numberFindings(
    "BU",
    mapping.unmapped.map(
      (u): Draft => ({ mode: "B", tier: "provisional", layer: "deterministic", ruleId: "MON-UNMAPPED", sectionId: UNMAPPED_SECTION, severity: "confirm", message: `개정 조문 ${u.key}(${u.change})은(는) 현재 규칙 팩의 어느 규칙과도 연결되지 않습니다. 처리방침에 미치는 영향은 도메인 검토가 필요합니다.`, fixHint: "정보보호실·법무 검토 후 규칙 팩 반영 여부를 결정하십시오.", location: { sectionId: UNMAPPED_SECTION, para: null, quote: "" }, trigger: trigger(u.key) }),
    ),
  );

  for (const policy of input.policies) {
    const drafts: Draft[] = [];
    perPolicy.set(policy.policyId, []);
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
      const paras = mergedParas(policy, impact.sectionId);

      if (paras.length === 0) {
        drafts.push({ ...base, layer: "deterministic", severity: "confirm", message: `개정 조문(${keys.join(", ")})과 연결된 ${impact.sectionId}(${section.title.ko}) 항목을 처리방침에서 찾지 못했습니다. 해당 항목이 필요한지 확인하십시오.${relatedNote}`, fixHint: "처리방침에 해당 항목이 있는지, 개정으로 새로 필요한지 검토하십시오.", location: { sectionId: impact.sectionId, para: null, quote: "" } });
        continue;
      }
      if (!deps.llm || !prompt) {
        drafts.push({ ...base, layer: "deterministic", severity: "confirm", message: `개정 조문(${keys.join(", ")})이 ${impact.sectionId}(${section.title.ko})의 규칙과 연결됩니다. 모델 판단을 실행하지 않아 영향 여부는 확인되지 않았습니다.${relatedNote}`, fixHint: "해당 항목을 개정 내용과 대조해 검토하십시오.", location: { sectionId: impact.sectionId, para: null, quote: "" } });
        continue;
      }

      llmUsed = true;
      const text = paras.map((p) => p.text).join("\n");
      let out: ImpactJudgeOutput;
      try {
        const res = await deps.llm.callStructured({ stageId: "M1", system: `${prompt.body}\n\n${UNTRUSTED_POLICY_NOTICE}`, user: impactUserTurn(impact, section, text), schema: ImpactJudgeSchema, schemaName: "MonitorImpactJudge", promptVersion: prompt.version });
        out = res.data;
      } catch (err) {
        warnings.push(`${policy.policyId} ${impact.sectionId}: the model judgement failed (${err instanceof Error ? err.name : "error"}); manual review required`);
        drafts.push({ ...base, layer: "llm", severity: "confirm", message: `개정 조문(${keys.join(", ")})의 영향을 ${impact.sectionId}(${section.title.ko})에서 자동으로 판단하지 못했습니다. 사람이 검토해야 합니다.${relatedNote}`, fixHint: "해당 항목을 수동으로 확인하십시오.", location: { sectionId: impact.sectionId, para: null, quote: "" } });
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
      const message = out.verdict === "review" ? `개정 조문(${keys.join(", ")})이 ${impact.sectionId}(${section.title.ko})에 영향을 주는지 확인이 필요합니다.${relatedNote}` : `${wording} 개정 조문: ${keys.join(", ")}.${relatedNote}`;
      drafts.push({ ...base, layer: "llm", severity, message, fixHint, location: { sectionId: impact.sectionId, para: paraOfQuote(paras, quote), quote } });
    }
    perPolicy.set(policy.policyId, numberFindings("B", drafts));
  }
  return { perPolicy, unmapped, adjustments, warnings, llmUsed };
}
