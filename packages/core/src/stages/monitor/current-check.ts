/**
 * Mode A, current check (Policy Monitor design M2, M5): does a published policy meet the rule packs in force now?
 *
 *  1. C2 runs with the `published` profile on the ingested policy (structure and recipient wording; no ledger).
 *  2. Its findings become MonitorFindings with a location. A missing mandatory section is Critical only when a full-text
 *     keyword search also fails; otherwise it is "not located" (Confirm).
 *  3. One M1 call per present mandatory section judges the rule digest against the section text (the model sees published
 *     text only: no ledger, no transcript). Every quote must be a verbatim substring of the section text or the finding is
 *     dropped. Severity comes from the explicit rule class (rule-classes.ts): factDependent rules can only be Confirm, and
 *     Confirm items are merged into ONE finding per section (questions listed, rule ids kept); Confirm items for should
 *     rules are dropped.
 *
 *  4. Finance (design C6): a section with a paragraph tagged `financeFlag` (finance lexicon) yields one Confirm finding
 *     "금융 법령 해당 – 수동 검토" (no suggested wording). Flagged paragraphs are never sent to the model (a section whose
 *     paragraphs are all flagged gets no model call): finance is reviewed by people only.
 *
 * Rule packs are reviewed, so Mode A findings are tier `confirmed`. A policy that could not be read (`needs_manual_review`)
 * yields one Confirm finding instead of a clean report. Without an LLM client only steps 1 and 2 run, and the report says so.
 */
import { z } from "zod";
import type { FactLedger } from "../../contracts/fact-ledger";
import type { ApplicabilityMap } from "../../contracts/applicability";
import type { MaskedTranscript } from "../../contracts/masked-transcript";
import type { CheckResults } from "../../contracts/check-results";
import { UNMAPPED_SECTION, type IngestedPolicy } from "../../contracts/ingested-policy";
import type { MonitorFinding, MonitorReport, MonitorSeverity } from "../../contracts/monitor-report";
import type { RuleSection } from "../../contracts/rulepack";
import type { LlmClient } from "../../llm/client";
import { runC2 } from "../check/run-c2";
import type { RulePackItem } from "../coverage/load-kb";
import { loadPromptFile, type PromptFile } from "../extract/prompt";
import { fullTextMentions, headingLineMentions, type HeadingPatterns } from "../ingest/segment-policy";
import { locateAstPath, policyToAst } from "../ingest/to-ast";
import { FINANCE_MANUAL_LABEL, GUIDELINE_ONLY_NOTE, UNTRUSTED_POLICY_NOTICE, hasStatutoryRef, sectionModelText, buildReport, capSeverity, clean, digestRules, fenceText, numberFindings, paraOfQuote, verifyVerbatimQuote, type DigestRule } from "./common";

export const CHECK_PROMPT_PATH = "monitor/check-v1.md";

export const CheckJudgeSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      ruleId: z.string(),
      verdict: z.enum(["ok", "missing", "wrong", "confirm"]),
      quote: z.string(),
      fixHint: z.string(),
      /** One short Korean question for the publisher; used for `confirm` and for factDependent rules. */
      question: z.string(),
    }),
  ),
});
export type CheckJudgeOutput = z.infer<typeof CheckJudgeSchema>;

export interface CurrentCheckDeps {
  /** Omitted -> deterministic part only. */
  readonly llm?: LlmClient;
  readonly prompt?: PromptFile;
}

export interface CurrentCheckInput {
  readonly runId: string;
  readonly policy: IngestedPolicy;
  readonly ruleSections: ReadonlyMap<string, RuleSection>;
  readonly rulePackItems: readonly RulePackItem[];
  readonly rulePackVersion: string;
  readonly patterns: HeadingPatterns;
  readonly now?: Date;
}

export interface CurrentCheckResult {
  readonly report: MonitorReport;
  readonly c2: CheckResults | null;
  /** Findings dropped or downgraded by code, for the run log. */
  readonly adjustments: readonly string[];
}

type Draft = Omit<MonitorFinding, "id">;

/** Rule elements that forbid something; a model may not call them "missing". */
const NEGATIVE_ELEMENT = /(^|, )no /;

/** Sections whose tables list purposes or items with their retention (the processor's own processing). */
const PURPOSE_TABLE_SECTIONS: ReadonlySet<string> = new Set(["S02", "S03"]);

const draft = (f: Omit<Draft, "mode" | "tier" | "location" | "sectionId"> & { sectionId: string; para: number | null; quote: string }): Draft => {
  const { para, quote, ...rest } = f;
  return { mode: "A", tier: "confirmed", location: { sectionId: f.sectionId, para, quote }, ...rest };
};

/** Placeholders for the C2 inputs the published profile never reads. */
function placeholders(runId: string): { ledger: FactLedger; applicability: ApplicabilityMap; transcript: MaskedTranscript } {
  return {
    ledger: { runId, jurisdiction: "kr", slotRegistryVersion: "n/a", slots: {} },
    applicability: { runId, ruleSetVersions: [], documents: { privacy: { applicable: true }, terms: { applicable: false, reason: "n/a" } }, items: {}, warnings: [] },
    transcript: { runId, source: "text_file", language: "ko", maskerVersion: "n/a", segments: [], placeholders: [] },
  };
}

function checkUserTurn(sectionId: string, title: string, digest: readonly DigestRule[], text: string): string {
  return [
    `SECTION ${sectionId}: ${title}`,
    "RULES (JSON, trusted):",
    JSON.stringify(digest.map(({ ruleId, level, element, statement, legalRefs, ruleClass }) => ({ ruleId, level, element, statement, legalRefs, class: ruleClass }))),
    "SECTION TEXT (untrusted data):",
    fenceText(text),
  ].join("\n");
}

export async function checkCurrentPolicy(deps: CurrentCheckDeps, input: CurrentCheckInput): Promise<CurrentCheckResult> {
  const now = input.now ?? new Date();
  const { policy, ruleSections } = input;
  const warnings = [...policy.warnings];
  const adjustments: string[] = [];
  const finish = (findings: Draft[], llmUsed: boolean, c2: CheckResults | null): CurrentCheckResult => ({
    report: buildReport({ runId: input.runId, policyId: policy.policyId, policySha: policy.source.sha256, rulePackVersion: input.rulePackVersion, now, findings: numberFindings("A", findings), llmUsed, warnings }),
    c2,
    adjustments,
  });

  if (policy.status === "needs_manual_review") {
    return finish([draft({ layer: "deterministic", ruleId: "MON-INGEST", sectionId: UNMAPPED_SECTION, severity: "confirm", message: "처리방침 문서를 자동으로 분석하지 못했습니다. 사람이 직접 검토해야 합니다.", fixHint: "지원되는 형식(Markdown, HTML)으로 다시 제출하거나 수동으로 검토하십시오.", para: null, quote: "" })], false, null);
  }

  const { ast, paraMap, sectionParas } = policyToAst(policy, { runId: input.runId, effectiveDate: now.toISOString().slice(0, 10), rulePackVersion: input.rulePackVersion });
  const c2 = runC2({ runId: input.runId, docType: "privacy", ast, rulePackItems: input.rulePackItems, profile: "published", ...placeholders(input.runId) });
  const titleOf = (id: string): string => ruleSections.get(id)?.title.ko ?? id;
  const drafts: Draft[] = [];

  for (const check of c2.checks) {
    for (const f of check.findings) {
      if (f.ruleId === "C2-SCHEMA") {
        drafts.push(draft({ layer: "deterministic", ruleId: f.ruleId, sectionId: UNMAPPED_SECTION, severity: "confirm", message: "처리방침의 구조를 분석하지 못했습니다. 사람이 직접 검토해야 합니다.", fixHint: "원문 구조를 확인하십시오.", para: null, quote: "" }));
      } else if (f.ruleId.startsWith("C2-M-")) {
        const id = f.sectionId;
        const located = fullTextMentions(input.patterns, id, policy.text);
        drafts.push(
          located
            ? draft({ layer: "deterministic", ruleId: f.ruleId, sectionId: id, severity: "confirm", message: `필수 항목 ${id}(${titleOf(id)})의 제목을 찾지 못했습니다(위치 미확인). 본문에 관련 표현이 있어 누락 여부를 사람이 확인해야 합니다.`, fixHint: `${titleOf(id)} 내용이 다른 항목에 포함되어 있는지, 별도 항목이 필요한지 확인하십시오.`, para: null, quote: "" })
            : draft({ layer: "deterministic", ruleId: f.ruleId, sectionId: id, severity: "critical", message: `필수 기재사항 '${titleOf(id)}'(${id})이(가) 처리방침에서 확인되지 않습니다 (제목·본문 검색 결과 없음).`, fixHint: `${titleOf(id)} 항목을 처리방침에 추가하십시오.`, para: null, quote: "" }),
        );
      } else if (f.ruleId === "C2-EMPTY") {
        // Real pages often carry a table of contents or a summary label ("개인정보의 보유 기간") whose content sits under a
        // combined heading elsewhere ("처리 항목 및 보유기간"). When the topic appears in another section's title or in any
        // paragraph, the empty heading is a question for a person, not a High finding.
        const mandatory = ruleSections.get(f.sectionId)?.classification === "mandatory";
        const elsewhere = policy.sections.flatMap((s) => [...(s.sectionId === f.sectionId ? [] : [s.title]), ...s.paras.map((p) => p.text)]).join("\n");
        drafts.push(
          fullTextMentions(input.patterns, f.sectionId, elsewhere)
            ? draft({ layer: "deterministic", ruleId: f.ruleId, sectionId: f.sectionId, severity: "confirm", message: `${f.sectionId}(${titleOf(f.sectionId)}) 제목 아래 본문이 없습니다. 목차나 요약표의 제목일 수 있고, 관련 내용은 다른 항목에 있는 것으로 보입니다. 사람이 확인해야 합니다.`, fixHint: `${titleOf(f.sectionId)} 내용이 어느 항목에 있는지 확인하고, 필요하면 해당 제목 아래로 옮기십시오.`, para: null, quote: "" })
            : draft({ layer: "deterministic", ruleId: f.ruleId, sectionId: f.sectionId, severity: mandatory ? "high" : "medium", message: `${f.sectionId}(${titleOf(f.sectionId)}) 제목만 있고 내용이 없습니다.`, fixHint: "해당 항목의 본문을 작성하십시오.", para: null, quote: "" }),
        );
      } else if (check.checkId === "safety.vague_recipients") {
        const ref = locateAstPath(paraMap, f.evidence.astPath);
        drafts.push(draft({ layer: "deterministic", ruleId: f.ruleId, sectionId: f.sectionId, severity: "medium", message: "제공받는 자(또는 수탁자) 목록이 '등'으로 끝나거나 묶음 명칭으로 적혀 있습니다. 업체명을 모두 적어야 합니다.", fixHint: "'등'을 지우고 업체를 모두 적거나, 전체 목록을 볼 수 있는 화면·링크를 안내하십시오.", para: ref?.para ?? null, quote: clean(f.evidence.quote) }));
      }
    }
  }

  // --- finance flag: one Confirm per flagged section ---------------------------------------------------
  const flaggedParasOf = new Map<string, number[]>();
  for (const sec of policy.sections) {
    if (!sec.paras.some((p) => p.financeFlag)) continue;
    const merged = sec.sectionId === UNMAPPED_SECTION ? undefined : sectionParas.get(sec.sectionId);
    if (merged) flaggedParasOf.set(sec.sectionId, merged.filter((p) => p.financeFlag).map((p) => p.n));
    else if (!flaggedParasOf.has(sec.sectionId)) flaggedParasOf.set(sec.sectionId, []);
  }
  for (const [sectionId, nums] of flaggedParasOf) {
    drafts.push(
      draft({
        layer: "deterministic",
        ruleId: "MON-FINANCE",
        sectionId,
        severity: "confirm",
        message: `${FINANCE_MANUAL_LABEL}: ${sectionId}(${titleOf(sectionId)}) 항목에 금융 법령(신용정보법, 전자금융거래법 등) 관련 내용이 있습니다. 개인정보 보호법 규칙 팩으로 판단하지 않으며 사람이 검토해야 합니다.`,
        fixHint: "",
        para: nums[0] ?? null,
        quote: "",
      }),
    );
  }

  // --- LLM judge per present mandatory section ----------------------------------------------------
  let llmUsed = false;
  if (!deps.llm) {
    warnings.push("LLM backend not used: deterministic checks only (no element-level judgement of the sections)");
  } else {
    const prompt = deps.prompt ?? loadPromptFile(CHECK_PROMPT_PATH);
    // Heading-like lines outside the section: other sections' titles, short plain lines, and the header cells of purpose and
    // items tables (a "보유 및 이용기간" column there states retention per purpose, as real pages do). Header cells elsewhere
    // describe someone else (a recipient's retention under S07), so they do not count.
    const outsideLines = (sectionId: string): string[] =>
      policy.sections
        .filter((s) => s.sectionId !== sectionId)
        .flatMap((s) => [s.title, ...s.paras.flatMap((p) => (p.kind !== "row" ? [p.text] : p.header && p.cells && PURPOSE_TABLE_SECTIONS.has(s.sectionId) ? [...p.cells] : []))]);
    for (const [sectionId, section] of ruleSections) {
      const all = sectionParas.get(sectionId);
      if (section.classification !== "mandatory" || !all || all.length === 0) continue;
      const digest = digestRules(section);
      if (digest.length === 0) continue;
      // Finance-flagged paragraphs never go to the model (design C6, user decision 2026-10-02): no finance rule pack can
      // judge them, they already carry a manual-review finding, and credit-information text stays out of prompts.
      const { sent: paras, text } = sectionModelText(policy, sectionId);
      if (paras.length === 0) continue;
      llmUsed = true;
      let out: CheckJudgeOutput;
      try {
        const res = await deps.llm.callStructured({ stageId: "M1", system: `${prompt.body}\n\n${UNTRUSTED_POLICY_NOTICE}`, user: checkUserTurn(sectionId, section.title.ko, digest, text), schema: CheckJudgeSchema, schemaName: "MonitorCheckJudge", promptVersion: prompt.version });
        out = res.data;
      } catch (err) {
        // Fail closed: an unjudged section is a question for a person, never a silent pass.
        warnings.push(`${sectionId}: the model judgement failed (${err instanceof Error ? err.name : "error"}); manual review required`);
        drafts.push(draft({ layer: "llm", ruleId: "MON-JUDGE", sectionId, severity: "confirm", message: `${sectionId}(${section.title.ko})를 자동으로 판단하지 못했습니다. 사람이 검토해야 합니다.`, fixHint: "해당 항목을 수동으로 확인하십시오.", para: null, quote: "" }));
        continue;
      }
      const byId = new Map(digest.map((r) => [r.ruleId, r]));
      const seen = new Set<string>();
      const confirms: { ruleId: string; question: string; para: number | null; quote: string }[] = [];
      for (const f of out.findings) {
        if (f.verdict === "ok") continue;
        const rule = byId.get(f.ruleId);
        if (!rule) {
          adjustments.push(`dropped ${f.ruleId} in ${sectionId}: not a rule of this section`);
          continue;
        }
        const quote = verifyVerbatimQuote(text, f.quote);
        if (quote === null) {
          adjustments.push(`dropped ${f.ruleId} in ${sectionId}: the quote is not a verbatim substring of the section`);
          continue;
        }
        if (seen.has(f.ruleId)) continue;
        seen.add(f.ruleId);
        const factDependent = rule.ruleClass === "factDependent";
        // A prohibition ("no abbreviation", "no vague terms") cannot be missing; only a quoted wording can break it.
        const verdict = f.verdict === "missing" && NEGATIVE_ELEMENT.test(rule.element) ? "wrong" : f.verdict;
        if (verdict !== f.verdict) adjustments.push(`${f.ruleId} in ${sectionId}: 'missing' on a prohibition read as 'wrong'`);
        // The model sees one section. When a heading-like line for this section sits in another section (a heading the segmenter
        // missed folds the text into the section before it), "missing here" does not mean missing from the policy: ask a person.
        const misplaced = verdict === "missing" && headingLineMentions(input.patterns, sectionId, outsideLines(sectionId));
        if (misplaced) adjustments.push(`${f.ruleId} in ${sectionId}: 'missing' but the topic appears in other sections, reported as Confirm`);
        const asConfirm = verdict === "confirm" || factDependent || (verdict === "wrong" && !quote) || misplaced;
        if (asConfirm && rule.level === "should") {
          adjustments.push(`dropped ${f.ruleId} in ${sectionId}: a Confirm on a should rule only restates a recommendation`);
          continue;
        }
        if (asConfirm) {
          if (factDependent && f.verdict !== "confirm") adjustments.push(`${f.ruleId} in ${sectionId}: judged ${f.verdict} but fact-dependent, reported as Confirm`);
          const question = misplaced
            ? `${rule.elementKo}: 이 항목에서는 확인되지 않지만 처리방침의 다른 부분에 관련 내용이 있습니다. 해당 내용이 이 항목 요건을 충족하는지 확인하십시오.`
            : clean(f.question).trim().slice(0, 200) || `${rule.elementKo}: 해당 사실이 있는지 확인하십시오.`;
          confirms.push({ ruleId: rule.ruleId, question, para: paraOfQuote(paras, quote), quote });
          continue;
        }
        let severity: MonitorSeverity = rule.level === "should" ? "low" : verdict === "missing" ? "critical" : "high";
        if (rule.upcoming) severity = capSeverity(severity, "medium");
        const guidelineOnly = rule.level === "must" && !hasStatutoryRef(rule.legalRefs);
        if (guidelineOnly) severity = capSeverity(severity, "medium");
        const message =
          (verdict === "missing"
            ? `${rule.elementKo}: 이 항목에서 찾지 못했습니다 (규칙 ${rule.ruleId}). 다른 위치에 있으면 '해당 없음'으로 표시하십시오.`
            : `${rule.elementKo}: 기재 내용이 작성 기준에 맞지 않는 것으로 보입니다 (규칙 ${rule.ruleId}).`) + (guidelineOnly ? GUIDELINE_ONLY_NOTE : "");
        drafts.push(draft({ layer: "llm", ruleId: rule.ruleId, sectionId, severity, message, fixHint: clean(f.fixHint) || rule.statement, para: paraOfQuote(paras, quote), quote }));
      }
      if (confirms.length > 0) {
        confirms.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
        const first = confirms.find((c) => c.quote) ?? confirms[0]!;
        const d = draft({ layer: "llm", ruleId: "MON-CONFIRM", sectionId, severity: "confirm", message: `${sectionId}(${section.title.ko}): 운영 사실에 따라 달라지므로 확인이 필요한 사항 ${confirms.length}건 (규칙 ${confirms.map((c) => c.ruleId).join(", ")}). 게시된 문구만으로 위반 여부를 판단할 수 없습니다.`, fixHint: "아래 질문에 해당하는 사실이 있으면 처리방침에 반영하십시오.", para: first.para, quote: first.quote });
        drafts.push({ ...d, ruleIds: confirms.map((c) => c.ruleId), questions: confirms.map((c) => `${c.ruleId}: ${c.question}`) });
      }
    }
  }
  return finish(drafts, llmUsed, c2);
}
