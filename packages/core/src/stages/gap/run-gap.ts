/**
 * R3 Gap Interviewer (design R3, stage "gap"): GapList + ledger excerpt -> QuestionSet (<= 10, max 2 rounds).
 *
 * Code first:
 *  - unanswered template questions (reason `missing`) are emitted VERBATIM from the Korean template;
 *  - the LLM (Sonnet, effort low) only writes context-specific follow-ups for gaps that already have an
 *    answer that is conflicting, vague or unsure (`conflict` / `low_confidence` / `needs_manual_review`).
 *    It may merge related gaps into one question. Its output is validated: every source ID must come from
 *    the input, and any gap it fails to cover falls back to the verbatim template question;
 *  - user decision: whenever delegation (S09) vs third-party provision (S07) is ambiguous, a fixed
 *    manual-review question is ALWAYS emitted first, with no LLM involvement and reserved budget.
 * The LLM sees no transcript; it gets masked evidence quotes (<= 3 per gap, from the ledger) only.
 */
import { z } from "zod";
import type { FactLedger } from "../../contracts/fact-ledger";
import type { Gap, GapList, QuestionId } from "../../contracts/gap-list";
import type { InterviewTemplate, QuestionNode } from "../../contracts/interview-template";
import { MAX_INTERVIEW_ROUNDS, MAX_QUESTIONS_PER_ROUND, QuestionSetSchema, type Question, type QuestionSet } from "../../contracts/question-set";
import { parseContract } from "../../contracts/common";
import type { LlmClient, TokenUsage } from "../../llm/client";
import { detectDelegationAmbiguity } from "../coverage/delegation";
import { loadPromptFile, type PromptFile } from "../extract/prompt";

export const GAP_PROMPT_PATH = "interview/v1.md";
export const DELEGATION_QUESTION_ID = "Q-MR-DELEG";
/** Template gate questions the manual-review question replaces. */
export const DELEGATION_COVERED_IDS: readonly QuestionId[] = ["Q-S07-01", "Q-S09-01"];

export const DELEGATION_QUESTION_TEXT =
  "개인정보를 받는 업체·기관마다 다음 중 어느 쪽인지 정리해 주세요. (1) 우리를 대신해 처리만 하는 경우(위탁), (2) 그 업체·기관이 자기 목적으로 쓰는 경우(제3자 제공). 표에 업체(기관)명, 받는 항목, 받은 쪽의 사용 목적, 위탁/제3자 제공 구분을 적어 주세요. 확실하지 않으면 '판단 보류'라고 적어 주세요. 법무·보안 담당자가 직접 확인합니다.";
export const DELEGATION_QUESTION_HELP = "위탁(제26조)과 제3자 제공(제17조)은 처리방침에서 들어가는 항목과 동의 요건이 달라서, 사람이 확인해야 해요.";

/** Model-facing output. Flat and enum-free so structured outputs accept it. */
export const GapOutputSchema = z.strictObject({
  followups: z.array(
    z.strictObject({
      sourceQuestionIds: z.array(z.string()).min(1),
      text: z.string(),
      help: z.string(),
    }),
  ),
});
export type GapOutput = z.infer<typeof GapOutputSchema>;

export interface GapInput {
  readonly runId: string;
  /** Interview round being asked (1 or 2). */
  readonly round: number;
  readonly gapList: GapList;
  readonly template: InterviewTemplate;
  readonly ledger: FactLedger;
}

export interface GapDeps {
  readonly llm: LlmClient;
  readonly prompt?: PromptFile;
}

export interface GapResult {
  readonly questionSet: QuestionSet;
  /** Gaps not asked this round because of the 10-question cap (ask next round or mark manual_review). */
  readonly deferred: readonly QuestionId[];
  readonly llmUsed: boolean;
  readonly delegationQuestion: boolean;
  readonly usage: TokenUsage;
}

const REFINE_REASONS: ReadonlySet<Gap["reason"]> = new Set(["conflict", "low_confidence", "needs_manual_review"]);
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const MAX_FOLLOWUP_TEXT = 500;

function templateQuestion(node: QuestionNode): Question {
  return {
    id: node.id,
    text: node.text,
    ...(node.help ? { help: node.help } : {}),
    answerType: node.answerType,
    ...(node.options ? { options: node.options } : {}),
    targets: node.targets,
    itemRefs: node.itemRefs,
    priority: node.priority,
    origin: "template",
    sourceQuestionIds: [node.id],
  };
}

function delegationQuestion(): Question {
  return {
    id: DELEGATION_QUESTION_ID,
    text: DELEGATION_QUESTION_TEXT,
    help: DELEGATION_QUESTION_HELP,
    answerType: "table",
    targets: ["gate.outsourcing", "gate.thirdPartyProvision"],
    itemRefs: ["S07", "S09"],
    priority: "must",
    origin: "followup",
    sourceQuestionIds: [...DELEGATION_COVERED_IDS],
  };
}

/** Masked evidence quotes for a gap's target slots (ledger excerpt for the LLM). */
function excerpt(gap: Gap, ledger: FactLedger): string[] {
  const quotes: string[] = [];
  for (const t of gap.targets) {
    for (const ev of ledger.slots[t]?.evidence ?? []) {
      if (ev.quote && quotes.length < 3) quotes.push(ev.quote.slice(0, 200));
    }
  }
  return quotes;
}

function mergedFollowup(round: number, index: number, sources: QuestionNode[], text: string, help: string): Question {
  const types = new Set(sources.map((s) => s.answerType));
  const single = sources.length === 1 ? sources[0] : undefined;
  const answerType = types.size === 1 ? sources[0].answerType : "text";
  const fallbackHelp = sources.map((s) => s.help).find(Boolean);
  return {
    id: `QF-R${round}-${String(index + 1).padStart(2, "0")}`,
    text: text.trim(),
    ...(help.trim() || fallbackHelp ? { help: help.trim() || fallbackHelp } : {}),
    answerType,
    ...(single?.options ? { options: single.options } : {}),
    targets: [...new Set(sources.flatMap((s) => s.targets))],
    itemRefs: [...new Set(sources.flatMap((s) => s.itemRefs))],
    priority: sources.some((s) => s.priority === "must") ? "must" : "should",
    origin: "followup",
    sourceQuestionIds: sources.map((s) => s.id),
  };
}

export async function runGap(deps: GapDeps, input: GapInput): Promise<GapResult> {
  if (!Number.isInteger(input.round) || input.round < 1 || input.round > MAX_INTERVIEW_ROUNDS) {
    throw new Error(`[GAP] round must be 1..${MAX_INTERVIEW_ROUNDS}, got ${input.round}`);
  }
  const nodes = new Map<string, QuestionNode>();
  for (const m of input.template.modules) for (const n of m.nodes) nodes.set(n.id, n);

  const delegation = detectDelegationAmbiguity(input.ledger).ambiguous;
  const gaps = input.gapList.gaps.filter((g) => !(delegation && DELEGATION_COVERED_IDS.includes(g.questionId)));

  // Verbatim template questions (missing answers).
  const verbatim: Question[] = [];
  const refine: Gap[] = [];
  for (const gap of gaps) {
    const node = nodes.get(gap.questionId);
    if (!node) throw new Error(`[GAP] gap references unknown template question ${gap.questionId}`);
    if (REFINE_REASONS.has(gap.reason)) refine.push(gap);
    else verbatim.push(templateQuestion(node));
  }

  // LLM follow-ups for conflicting / vague answers only.
  let usage = ZERO_USAGE;
  let llmUsed = false;
  const followups: Question[] = [];
  if (refine.length > 0) {
    const prompt = deps.prompt ?? loadPromptFile(GAP_PROMPT_PATH);
    const payload = refine
      .map((g) => ({ id: g.questionId, reason: g.reason, question: nodes.get(g.questionId)!.text, quotes: excerpt(g, input.ledger) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const res = await deps.llm.callStructured({
      stageId: "R3",
      system: prompt.body,
      user: JSON.stringify({ round: input.round, gaps: payload }),
      schema: GapOutputSchema,
      schemaName: "GapOutput",
      promptVersion: prompt.version,
    });
    llmUsed = true;
    usage = res.usage;

    const allowed = new Set(refine.map((g) => g.questionId));
    const covered = new Set<string>();
    for (const f of res.data.followups) {
      const ids = [...new Set(f.sourceQuestionIds)].filter((id) => allowed.has(id) && !covered.has(id));
      const text = f.text.trim();
      if (ids.length === 0 || text.length === 0 || text.length > MAX_FOLLOWUP_TEXT) continue;
      ids.forEach((id) => covered.add(id));
      followups.push(mergedFollowup(input.round, followups.length, ids.map((id) => nodes.get(id)!), text, f.help));
    }
    // Anything the model dropped or mangled falls back to the verbatim template question.
    for (const g of refine) if (!covered.has(g.questionId)) verbatim.push(templateQuestion(nodes.get(g.questionId)!));
  }

  // Order: manual-review first, then must before should, follow-ups before verbatim within a priority.
  const rank = (q: Question): number => (q.id === DELEGATION_QUESTION_ID ? 0 : (q.priority === "must" ? 1 : 3) + (q.origin === "followup" ? 0 : 1));
  const all = [...(delegation ? [delegationQuestion()] : []), ...followups, ...verbatim]
    .map((q, i) => ({ q, i }))
    .sort((a, b) => rank(a.q) - rank(b.q) || a.i - b.i)
    .map((x) => x.q);

  const asked = all.slice(0, MAX_QUESTIONS_PER_ROUND);
  const deferred = all.slice(MAX_QUESTIONS_PER_ROUND).flatMap((q) => q.sourceQuestionIds);
  const questionSet = parseContract("QuestionSet", QuestionSetSchema, { runId: input.runId, round: input.round, questions: asked });
  return { questionSet, deferred, llmUsed, delegationQuestion: delegation, usage };
}
