/**
 * Reviewer Sheet for the InfoSec office: per-section status, audit findings summary,
 * evidence pointers (slot -> transcript segment IDs) and open questions. Built as an RDoc so the
 * Markdown and HTML writers render it.
 */
import { collectSlotRefs, type DocAST, type SectionStatus } from "../../contracts/ast";
import type { AuditReport, Finding } from "../../contracts/audit-report";
import type { CheckResults } from "../../contracts/check-results";
import { DEFAULT_DISCLAIMER } from "./resolve";
import type { RBlock, RDoc, RRun, RSection } from "./types";

export interface ReviewedDoc {
  readonly ast: DocAST;
  readonly audit?: AuditReport;
  readonly checks?: CheckResults;
}

export interface ReviewerSheetInput {
  readonly docs: readonly ReviewedDoc[];
  /** slotId -> transcript segment IDs (see `evidenceFromLedger`). */
  readonly slotEvidence?: Readonly<Record<string, readonly string[]>>;
  readonly openQuestions?: readonly string[];
  readonly termsNotApplicableReason?: string;
  readonly warnings?: readonly string[];
}

export const STATUS_LABEL: Readonly<Record<SectionStatus, string>> = {
  drafted: "작성됨 (drafted)",
  not_processed_statement: "미처리 명시 (not_processed_statement)",
  omitted_recommended: "권장 항목 생략 (omitted_recommended)",
  manual_review: "수동 검토 필요 (manual_review)",
  not_applicable: "해당 없음 (not_applicable)",
};

const DOC_LABEL = { privacy: "개인정보 처리방침", terms: "이용약관" } as const;
const SEVERITY_ORDER = ["blocker", "major", "minor", "info"] as const;
const t = (text: string): RRun[] => [{ kind: "text", text }];
const cell = (text: string): RRun[] => t(text);
const table = (caption: string, header: string[], rows: string[][]): RBlock => ({ t: "table", caption, header, rows: rows.map((r) => r.map(cell)) });
const para = (text: string): RBlock => ({ t: "para", runs: t(text) });

/** Derives slotId -> segment IDs from anything shaped like a FactLedger. */
export function evidenceFromLedger(ledger: { slots: Record<string, { evidence: readonly { source: string; segmentId?: string; ref?: string }[] }> }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of Object.keys(ledger.slots).sort()) {
    const ids = [...new Set(ledger.slots[id]!.evidence.map((e) => (e.source === "transcript" ? e.segmentId : `${e.source}:${e.ref}`)).filter((x): x is string => !!x))].sort();
    if (ids.length > 0) out[id] = ids;
  }
  return out;
}

export function buildReviewerSheet(input: ReviewerSheetInput): RDoc {
  const sections: RSection[] = [];
  const add = (heading: string, blocks: RBlock[]) => sections.push({ id: `RS${sections.length + 1}`, anchor: `rs-${sections.length + 1}`, heading: `${sections.length + 1}. ${heading}`, blocks });
  const evidence = input.slotEvidence ?? {};

  // 1. Overview
  add("실행 개요", [
    table(
      "문서별 감사 결과",
      ["문서", "실행 ID", "감사 결과", "반복 회차", "법령 준수", "정확성", "명료성", "하우스 스타일", "일관성"],
      input.docs.map(({ ast, audit }) => [
        DOC_LABEL[ast.docType],
        ast.meta.runId,
        audit?.verdict ?? "감사 없음",
        audit ? `${audit.iteration}/3` : "-",
        ...(audit ? [audit.scores.legal, audit.scores.accuracy, audit.scores.clarity, audit.scores.houseStyle, audit.scores.consistency].map(String) : ["-", "-", "-", "-", "-"]),
      ]),
    ),
    ...(input.termsNotApplicableReason ? [para(`이용약관: 해당 없음 — ${input.termsNotApplicableReason}`)] : []),
  ]);

  // 2. Section status per document
  for (const { ast } of input.docs) {
    add(`섹션 상태 — ${DOC_LABEL[ast.docType]}`, [
      table(
        "섹션별 상태",
        ["ID", "제목", "상태", "근거 슬롯"],
        ast.sections.map((s) => [s.id, s.title, STATUS_LABEL[s.status], [...new Set([...s.trace.slotRefs, ...collectSlotRefs(s)])].sort().join(", ") || "-"]),
      ),
    ]);
  }

  // 3. Findings
  const findings: { doc: string; f: Finding }[] = [];
  const seen = new Set<string>();
  for (const d of input.docs) {
    const all = [...(d.audit?.findings ?? []), ...(d.checks?.checks.flatMap((c) => c.findings) ?? [])];
    for (const f of all) {
      const key = `${d.ast.docType}:${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ doc: DOC_LABEL[d.ast.docType], f });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.f.severity) - SEVERITY_ORDER.indexOf(b.f.severity));
  const counts = SEVERITY_ORDER.map((s) => `${s} ${findings.filter((x) => x.f.severity === s).length}건`).join(" / ");
  add("감사 지적사항 요약", [
    para(findings.length === 0 ? "지적사항이 없습니다." : `총 ${findings.length}건 — ${counts}`),
    ...(findings.length > 0
      ? [table("지적사항 목록", ["문서", "심각도", "규칙", "섹션", "내용", "수정 제안"], findings.map(({ doc, f }) => [doc, f.severity, f.ruleId, f.sectionId, f.message, f.fixHint || "-"]))]
      : []),
  ]);

  // 4. Evidence pointers
  const evRows: string[][] = [];
  for (const { ast } of input.docs) {
    const slots = new Set<string>();
    for (const s of ast.sections) {
      for (const r of s.trace.slotRefs) slots.add(r);
      for (const r of collectSlotRefs(s)) slots.add(r);
    }
    for (const slot of [...slots].sort()) evRows.push([DOC_LABEL[ast.docType], slot, (evidence[slot] ?? []).join(", ") || "근거 없음"]);
  }
  add("근거 위치 (슬롯 → 전사 세그먼트)", [evRows.length > 0 ? table("근거 포인터", ["문서", "슬롯", "전사 세그먼트 ID"], evRows) : para("참조된 슬롯이 없습니다.")]);

  // 5. Open questions
  const q = input.openQuestions ?? [];
  add("미결 질문", [q.length > 0 ? { t: "list", ordered: true, items: q.map(t) } : para("미결 질문이 없습니다.")]);

  // 6. Warnings
  const w = input.warnings ?? [];
  add("경고", [w.length > 0 ? { t: "list", ordered: false, items: w.map(t) } : para("경고가 없습니다.")]);

  const m = input.docs[0]?.ast.meta;
  return {
    lang: "ko",
    title: "검토 시트 (Reviewer Sheet)",
    subtitle: ["정보보호실 검토용 — 이 시트는 게시용 문서가 아닙니다."],
    sections,
    disclaimer: DEFAULT_DISCLAIMER,
    stamps: m ? [`실행 ID: ${m.runId}`, `규칙팩 버전: ${m.rulePackVersion}`, `법령 스냅샷: ${m.lawSnapshotId}`] : [],
  };
}
