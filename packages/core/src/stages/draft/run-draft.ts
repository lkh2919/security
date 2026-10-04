/**
 * R5P / R5T Drafters (design R3): clause-first, LLM only where a clause does not cover the facts.
 *
 * Per section (concurrency 4):
 *   1. applicability `no` (or `pending`) -> omitted; S07/S09/S10 with a known `no` -> a fixed not-processed statement;
 *   2. `unknown` gate -> manual_review note (never drafted as fact);
 *   3. warn-only types (S04, S21, S22, A1, X1) -> manual_review placeholder, never a fabricated body;
 *   4. T13 -> fixed link to the privacy policy;
 *   5. best vetted candidate with full coverage renders in code (zero tokens), trace.clauseRefs set;
 *   6. otherwise one LLM call per section (masked facts, rule slice, clause examples, approved style, fix findings).
 * The drafters never see the transcript, the auditor prompt, the rubric or the vault. A fix loop passes `previous` and
 * `fixFindings`; only sections with findings are redrafted, the rest are copied.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BlockSchema, collectCitationIds, collectSlotRefs, type Block, type DocAST, type DocMeta, type Inline, type SectionAST } from "../../contracts/ast";
import type { ApplicabilityMap } from "../../contracts/applicability";
import type { Finding } from "../../contracts/audit-report";
import type { ClauseSelection } from "../../contracts/clause-selection";
import type { FactLedger } from "../../contracts/fact-ledger";
import type { HouseStyleFile } from "../../contracts/house-style";
import type { RuleSection } from "../../contracts/rulepack";
import type { Citation } from "../../contracts/statutes";
import type { JsonValue } from "../../contracts/common";
import type { LlmClient, TokenUsage } from "../../llm/client";
import { getStagePolicy } from "../../llm/models";
import { wrapUntrusted, UNTRUSTED_NOTICE } from "../intake/sanitize";
import { loadPromptFile, type PromptFile } from "../extract/prompt";
import type { ClauseLibrary } from "../match/load-clauses";
import { renderClause } from "./render-clause";
import { passwordItemGap, rejoinRetentionGap } from "../check/consistency";

export interface RemedyAgency {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly url: string;
  /** Only `verified` (or `verified_secondary`) bodies are written as current facts; `pending` ones go to a person. */
  readonly status: "verified" | "verified_secondary" | "pending";
  readonly verifiedBy?: readonly { readonly url: string; readonly fetched: string; readonly version?: string }[];
}

/** Latest date a source for the body was checked (undefined when none). */
export function remedyVerifiedOn(a: Pick<RemedyAgency, "verifiedBy">): string | undefined {
  return (a.verifiedBy ?? []).map((v) => v.fetched).sort().at(-1);
}

export function loadRemedyAgencies(repoRoot: string): RemedyAgency[] {
  const file = join(repoRoot, "kb", "jurisdictions", "kr", "statutes", "remedy-agencies.json");
  if (!existsSync(file)) return [];
  return ((JSON.parse(readFileSync(file, "utf8")) as { agencies?: RemedyAgency[] }).agencies ?? []);
}

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");

export const DRAFT_PROMPT_PATHS = { privacy: "draft-privacy/v1.md", terms: "draft-terms/v1.md" } as const;
export const DRAFT_CONCURRENCY = 4;
/** Special types that are never drafted, only flagged (design R11.1 W cases). */
export const WARN_ONLY: ReadonlySet<string> = new Set(["S04", "S21", "S22", "A1", "X1"]);

const NOT_PROCESSED: Readonly<Record<string, string>> = {
  S07: "회사는 이용자의 개인정보를 제3자에게 제공하지 않습니다.",
  S09: "회사는 개인정보 처리업무를 외부에 위탁하지 않습니다.",
  S10: "회사는 이용자의 개인정보를 국외로 이전하거나 국외에서 직접 수집하지 않습니다.",
};

export const SectionDraftSchema = z.strictObject({
  status: z.enum(["drafted", "manual_review"]),
  blocks: z.array(BlockSchema),
  missingFacts: z.array(z.string()),
});
export type SectionDraft = z.infer<typeof SectionDraftSchema>;

export interface DraftInput {
  readonly docType: "privacy" | "terms";
  readonly runId: string;
  readonly effectiveDate: string;
  readonly lawSnapshotId: string;
  readonly rulePackVersion: string;
  readonly ledger: FactLedger;
  readonly applicability: ApplicabilityMap;
  readonly selection: ClauseSelection;
  readonly library: ClauseLibrary;
  readonly ruleSections: ReadonlyMap<string, RuleSection>;
  readonly houseStyle: HouseStyleFile;
  readonly citations: readonly Citation[];
  /** S20 remedy bodies (default: kb/jurisdictions/kr/statutes/remedy-agencies.json). */
  readonly remedyAgencies?: readonly RemedyAgency[];
  /** Redraft only sections named in `fixFindings`, copying the rest from `previous`. */
  readonly previous?: DocAST;
  readonly fixFindings?: readonly Finding[];
}

export interface DraftDeps {
  readonly llm: LlmClient;
  readonly prompt?: PromptFile;
}

export interface DraftResult {
  readonly ast: DocAST;
  readonly llmSections: readonly string[];
  readonly clauseSections: readonly string[];
  readonly usage: TokenUsage;
  /** Facts the drafters could not find (for the Reviewer Sheet). */
  readonly missingFacts: readonly { readonly sectionId: string; readonly text: string }[];
}

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
});

const text = (t: string, slotRef?: string): { t: "text"; text: string; slotRef?: string } => ({ t: "text", text: t, ...(slotRef ? { slotRef } : {}) });
const note = (kind: "manual_review" | "info", t: string): Block => ({ t: "note", kind, runs: [text(t)] });

function traceOf(section: Omit<SectionAST, "trace">, rs: RuleSection | undefined, clauseRefs: string[], styleRefs: string[], extraSlotRefs: string[] = []): SectionAST["trace"] {
  const tmp = { ...section, trace: { slotRefs: [], clauseRefs: [], ruleRefs: [], styleRefs: [], citationIds: [] } } as SectionAST;
  return {
    slotRefs: [...new Set([...collectSlotRefs(tmp), ...extraSlotRefs])].sort(),
    clauseRefs,
    ruleRefs: (rs?.rules ?? []).filter((r) => r.level === "must").map((r) => r.ruleId),
    styleRefs,
    citationIds: collectCitationIds(tmp),
  };
}

/** Plain text of a section, one line per paragraph, list item and table row. */
export function sectionText(sec: Pick<SectionAST, "blocks">): string {
  const line = (runs: readonly Inline[]): string => runs.map((r) => (r.t === "text" || r.t === "link" ? r.text : "")).join("");
  return sec.blocks
    .flatMap((b) => (b.t === "para" || b.t === "note" ? [line(b.runs)] : b.t === "list" ? b.items.map(line) : b.rows.map((row) => row.map(line).join(" | "))))
    .join("\n");
}

/** Filled ledger values relevant to one section: profile/gate slots, the section's own slots and, for terms, all terms slots. */
export function factsForSection(ledger: FactLedger, docType: "privacy" | "terms", sectionId: string): Record<string, JsonValue> {
  const own = docType === "privacy" ? `privacy.${sectionId}_` : "terms.";
  // The purpose, item and retention sections describe the same processing tasks: each sees the others' task lists, so a task
  // named in one (an overseas processor, a statutory record, generated logs) gets its purpose, basis and period in the others.
  const TASK_FACTS = ["privacy.S02_purposes", "privacy.S03_", "privacy.S05_retention", "privacy.S05_hrStatutoryRecords"];
  const extra: Record<string, string[]> = {
    S02: [...TASK_FACTS, "privacy.S09_processors", "privacy.S10_overseas", "privacy.S14_devices"],
    S03: TASK_FACTS,
    S07: ["privacy.S09_roleAssessment"],
    S05: ["privacy.S02_purposes", "privacy.S03_items", "privacy.S03_generatedItems", "privacy.S05_", "privacy.S14_devices"],
  };
  const extras = extra[sectionId] ?? [];
  const out: Record<string, JsonValue> = {};
  for (const [id, e] of Object.entries(ledger.slots).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (e.status !== "filled" || e.value === null) continue;
    if (id.startsWith("profile.") || id.startsWith("gate.") || id.startsWith(own) || extras.some((p) => id.startsWith(p))) out[id] = e.value;
  }
  return out;
}

function conflictNote(ledger: FactLedger, slots: readonly string[]): string[] {
  return slots.filter((s) => ledger.slots[s] && ledger.slots[s]!.status !== "filled").map((s) => `${s}: ${ledger.slots[s]!.status}`);
}

export async function draftDocument(deps: DraftDeps, input: DraftInput): Promise<DraftResult> {
  const { docType } = input;
  const stageId = docType === "privacy" ? "R5P" : "R5T";
  const prompt = deps.prompt ?? loadPromptFile(DRAFT_PROMPT_PATHS[docType]);
  const policy = getStagePolicy(stageId);
  const prefix = docType === "privacy" ? /^(S\d{2}|A1|X1)$/ : /^T\d{2}$/;

  const flagged = new Set((input.fixFindings ?? []).map((f) => f.sectionId));
  const prevById = new Map((input.previous?.sections ?? []).map((s) => [s.id, s]));
  const findingsBy = (id: string): Finding[] => (input.fixFindings ?? []).filter((f) => f.sectionId === id);
  const approvedStyle = input.houseStyle.rules.filter((r) => r.status === "approved" && (r.scope === docType || r.scope === "both"));
  const citable = new Set(input.citations.map((c) => c.citationId));
  const allowedFor = (rs: RuleSection, facts: Record<string, JsonValue>): string[] => {
    // The section's verified legal refs, plus any citationId the confirmed facts carry (statutory retention rows).
    const fromFacts = [...JSON.stringify(facts).matchAll(/"citationId":"([^"]+)"/g)].map((m) => m[1]!);
    return [...new Set([...Object.keys(rs.legalRefs), ...fromFacts])].filter((k) => citable.has(k)).sort();
  };
  const libById = new Map(input.library.clauses.map((c) => [c.record.clauseId, c]));
  const missingFacts: { sectionId: string; text: string }[] = [];
  const llmSections: string[] = [];
  const clauseSections: string[] = [];
  let usage = ZERO;

  const ids = Object.keys(input.applicability.items).filter((id) => prefix.test(id)).sort();

  const delegationFlag = input.applicability.warnings.some((w) => w.code === "DELEGATION_VS_PROVISION");
  const ambiguousPartiesFor = (id: string): Record<string, JsonValue>[] => {
    if (docType !== "privacy" || !delegationFlag || (id !== "S07" && id !== "S09")) return [];
    const e = input.ledger.slots["privacy.S09_roleAssessment"];
    if (e?.status !== "filled" || !Array.isArray(e.value)) return [];
    return (e.value as Record<string, JsonValue>[]).filter((r) => r && typeof r === "object" && r["ownPurposeUse"] !== "no");
  };

  // Terms articles are drafted one by one, so each call sees which sibling article owns which facts (cross-article consistency).
  const outline =
    docType === "terms"
      ? ids
          .filter((id) => !["no", "pending"].includes(input.applicability.items[id]!.state))
          .map((id) => {
            const r = input.ruleSections.get(id);
            const owns = (r?.slots ?? []).filter((sl) => sl.startsWith("terms.") && input.ledger.slots[sl]?.status === "filled");
            return { id, title: r?.title.ko ?? id, owns };
          })
      : [];
  // On a fix pass, the current text of sibling sections a finding names, so the redraft can align to them.
  const relatedFor = (id: string): { id: string; title: string; text: string }[] => {
    if (!input.previous) return [];
    const named = new Set(findingsBy(id).flatMap((f) => [...`${f.message} ${f.fixHint ?? ""}`.matchAll(/\b(S\d{2}|T\d{2}|A1)\b/g)].map((m) => m[1]!)));
    named.delete(id);
    return [...named].sort().flatMap((sid) => {
      const sec = prevById.get(sid);
      return sec ? [{ id: sid, title: sec.title, text: sectionText(sec).slice(0, 2000) }] : [];
    });
  };

  async function one(id: string): Promise<SectionAST | null> {
    const item = input.applicability.items[id]!;
    const rs = input.ruleSections.get(id);
    const title = rs?.title.ko ?? id;
    const classification = rs?.classification ?? "conditional";
    if (!input.applicability.documents[docType].applicable) return null;
    if (item.state === "pending") return null;

    const prev = prevById.get(id);
    if (input.previous && prev && !flagged.has(id)) return prev; // fix loop: untouched sections are copied

    const styleRefs = input.selection.sections[id]?.styleRefs ?? approvedStyle.map((r) => r.id);
    const finish = (status: SectionAST["status"], blocks: Block[], clauseRefs: string[] = [], extraSlotRefs: string[] = []): SectionAST => {
      const base = { id, title, status, blocks };
      return { ...base, trace: traceOf(base, rs, clauseRefs, styleRefs, extraSlotRefs) };
    };

    if (item.state === "no") {
      const statement = docType === "privacy" ? NOT_PROCESSED[id] : undefined;
      if (statement) return finish("not_processed_statement", [{ t: "para", runs: [text(statement, item.basisSlots[0])] }]);
      return null;
    }
    // Delegation vs provision ambiguity (user decision: always manual review, both candidates shown): S09 drafts the
    // outsourcing candidate rows and S07 the provision candidate rows for the parties whose role is unclear.
    const ambiguous = ambiguousPartiesFor(id);
    // A conflict between the two documents' facts goes to the sections that state either side, never drafted as settled.
    const conflicts = [
      ...((docType === "terms" && (id === "T06" || id === "T07")) || (docType === "privacy" && id === "S05") ? [rejoinRetentionGap(input.ledger)] : []),
      ...(docType === "privacy" && (id === "S03" || id === "S11") ? [passwordItemGap(input.ledger)] : []),
    ].filter((x): x is string => x !== null);
    for (const c of conflicts) missingFacts.push({ sectionId: id, text: c });
    if (item.state === "unknown" && ambiguous.length === 0) {
      // Slot ids go to the Reviewer Sheet (missingFacts), never into reader-facing text.
      const what = conflictNote(input.ledger, item.basisSlots);
      missingFacts.push({ sectionId: id, text: `${title}: 적용 여부가 확인되지 않았습니다.${what.length ? ` (${what.join(", ")})` : ""}` });
      return finish("manual_review", [note("manual_review", `${title}: 적용 여부를 확인해야 합니다. 관련 질문의 답변이 비어 있거나 서로 맞지 않습니다.`)]);
    }

    if (WARN_ONLY.has(id)) {
      missingFacts.push({ sectionId: id, text: `${title}: 특수 유형으로 사람의 검토가 필요합니다.` });
      return finish("manual_review", [note("manual_review", `${title}: 이 항목은 자동으로 작성하지 않습니다. 해당 사실과 법적 요건을 확인한 뒤 담당자가 작성해야 합니다.`)]);
    }

    if (docType === "terms" && id === "T13") {
      const url = input.ledger.slots["terms.privacyPolicyUrl"];
      if (url?.status === "filled" && typeof url.value === "string") {
        return finish("drafted", [{ t: "para", runs: [text("회사는 이용자의 개인정보를 보호하기 위하여 「개인정보 보호법」 등 관련 법령을 준수하며, 개인정보의 처리에 관한 사항은 "), { t: "link", text: "개인정보 처리방침", href: url.value }, text("에 따릅니다.")] }], [], ["terms.privacyPolicyUrl"]);
      }
      // Without the link the article still points to the policy by its title (R-T13-001); only the link stays open.
      missingFacts.push({ sectionId: id, text: "개인정보 처리방침 링크(terms.privacyPolicyUrl)가 필요합니다." });
      return finish("manual_review", [
        { t: "para", runs: [text("회사는 이용자의 개인정보를 보호하기 위하여 「개인정보 보호법」 등 관련 법령을 준수하며, 개인정보의 처리에 관한 사항은 회사의 「개인정보 처리방침」에 따릅니다.")] },
        note("manual_review", "개인정보 처리방침의 게시 위치(링크)가 확인되지 않았습니다. 링크를 확인해 이 조항에 넣어야 합니다."),
      ]);
    }

    // Clause-first (only when the section is not being fixed by findings: fixes need an LLM edit).
    const candidates = input.selection.sections[id]?.candidates ?? [];
    if (findingsBy(id).length === 0 && ambiguous.length === 0) {
      const full = candidates.find((c) => c.coverage === "full" && libById.has(c.clauseId));
      if (full) {
        const r = renderClause(libById.get(full.clauseId)!.record, input.ledger);
        if (r.rendered) {
          clauseSections.push(id);
          return finish("drafted", r.blocks, [full.clauseId]);
        }
      }
    }

    // LLM draft of this section only.
    if (!rs) return finish("manual_review", [note("manual_review", `${title}: 규칙 묶음이 없어 작성하지 못했습니다.`)]);
    llmSections.push(id);
    const examples = candidates
      .filter((c) => c.coverage !== "none" && libById.has(c.clauseId))
      .slice(0, 2)
      .map((c) => ({ clauseId: c.clauseId, body: libById.get(c.clauseId)!.record.body }));
    const facts = factsForSection(input.ledger, docType, id);
    const related = relatedFor(id);
    const payload = {
      section: { id, title, classification, handling: rs.handling },
      rules: rs.rules.filter((r) => r.level !== "may").map((r) => ({ ruleId: r.ruleId, level: r.level, statement: r.statement, cite: r.legalRefs.filter((c) => citable.has(c)) })),
      document: { effectiveDate: input.effectiveDate },
      facts,
      clauseExamples: examples,
      styleRules: approvedStyle.map((r) => ({ id: r.id, rule: r.rule })),
      allowedCitations: allowedFor(rs, facts),
      fixFindings: findingsBy(id).map((f) => ({ ruleId: f.ruleId, severity: f.severity, message: f.message, quote: f.evidence.quote, fixHint: f.fixHint })),
      ...(docType === "terms" ? { documentOutline: outline.filter((o) => o.id !== id) } : {}),
      ...(related.length > 0 ? { relatedSections: related } : {}),
      ...(ambiguous.length > 0 ? { ambiguousParties: ambiguous } : {}),
      ...(conflicts.length > 0 ? { factConflicts: conflicts } : {}),
      // S20: remedy bodies from the KB (verified on the bodies' sites or law.go.kr); never from model memory, which still
      // names 대검찰청 (abolished 2026-10-02).
      ...(docType === "privacy" && id === "S20" ? { remedyAgencies: (input.remedyAgencies ?? loadRemedyAgencies(REPO_ROOT)).map((a) => ({ name: a.name, phone: a.phone, url: a.url, status: a.status, ...(remedyVerifiedOn(a) ? { verifiedOn: remedyVerifiedOn(a) } : {}) })) } : {}),
    };
    const res = await deps.llm.callStructured({
      stageId,
      system: `${prompt.body}\n\n${UNTRUSTED_NOTICE}`,
      user: wrapUntrusted(JSON.stringify(payload)),
      schema: SectionDraftSchema,
      schemaName: "SectionDraft",
      promptVersion: prompt.version,
    });
    usage = add(usage, res.usage);
    for (const m of res.data.missingFacts) missingFacts.push({ sectionId: id, text: m });
    const blocks = res.data.blocks.length > 0 ? res.data.blocks : [note("manual_review", `${title}: 초안을 작성하지 못했습니다.`)];
    if (ambiguous.length > 0) {
      missingFacts.push({ sectionId: id, text: `${title}: ${ambiguous.map((a) => a.party).join(", ")}의 위탁/제3자 제공 여부를 담당자가 결정해야 합니다.` });
      return finish("manual_review", blocks);
    }
    return finish(res.data.blocks.length === 0 ? "manual_review" : res.data.status, blocks);
  }

  // Bounded concurrency over sections, results kept in section order.
  const results = new Array<SectionAST | null>(ids.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(DRAFT_CONCURRENCY, ids.length) }, async () => {
      for (let i = next++; i < ids.length; i = next++) results[i] = await one(ids[i]!);
    }),
  );

  const meta: DocMeta = {
    runId: input.runId,
    effectiveDate: input.effectiveDate,
    rulePackVersion: input.rulePackVersion,
    clauseLibVersion: input.selection.clauseLibVersion,
    houseStyleVersion: input.selection.houseStyleVersion,
    lawSnapshotId: input.lawSnapshotId,
    promptVersions: { [stageId]: prompt.version },
    models: { [stageId]: policy.modelId },
  };
  const warnings = input.applicability.warnings.filter((w) => !w.itemId || prefix.test(w.itemId));
  const ast = { docType, meta, sections: results.filter((s): s is SectionAST => s !== null), warnings } as DocAST;
  return { ast, llmSections: llmSections.sort(), clauseSections: clauseSections.sort(), usage, missingFacts: missingFacts.sort((a, b) => (a.sectionId < b.sectionId ? -1 : 1)) };
}
