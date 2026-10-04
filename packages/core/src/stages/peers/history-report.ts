/**
 * Korean report of a historical comparison (`runs/<tenant>/peers/history-<law>-<date>.md`). Reference only: fixed label, "co-occurred,
 * not caused by" wording, masked quotes of at most 25 words, peers in registry order (no score, no rating, no ranking).
 */
import { MONITOR_DISCLAIMER } from "../../contracts/monitor-report";
import { PEER_SIGNAL_LABEL, PEER_UNKNOWN_CAUSE_LABEL } from "../../contracts/peers";
import { safeText } from "../monitor/report";
import { PEER_NOT_RATED_NOTE } from "./report";
import { bestConfidence, collapseAlignments, detailList, refLabel, splitArticleKey } from "./collapse";
import type { HistoryResult } from "./history";

const KIND_KO = { added: "추가", removed: "삭제", modified: "수정" } as const;
const CONF_KO = { high: "높음", medium: "중간", low: "낮음" } as const;
export const CO_OCCURRED_NOTE = "개정 전후 버전에서 같은 시기에 나타난 변경(co-occurred)을 보여 줄 뿐이며, 개정이 원인(caused by)이라는 뜻이 아닙니다 (co-occurred, not caused by).";

export interface HistoryReportInput {
  readonly result: HistoryResult;
  readonly tenantId: string;
  readonly date: string;
  /** Section id -> Korean title. */
  readonly titles?: Readonly<Record<string, string>>;
  /** Promulgation info and how the previous law version was found. */
  readonly amendment: { readonly oldMst: string; readonly newMst: string; readonly promulgatedOn: string | null; readonly promulgationNo: string; readonly howFound: string };
}

export function renderHistoryReport(i: HistoryReportInput): string {
  const r = i.result;
  const title = (id: string): string => (i.titles?.[id] ? `${id} ${safeText(i.titles[id]!)}` : id);
  const out: string[] = [`# 피어 정책 이력 비교 보고서: ${safeText(r.law)} 개정 ${safeText(i.date)}`, "", `> ${PEER_SIGNAL_LABEL}`, `> ${MONITOR_DISCLAIMER}`, "", PEER_NOT_RATED_NOTE, "", CO_OCCURRED_NOTE, ""];
  out.push(
    `- 테넌트: ${safeText(i.tenantId)}`,
    `- 개정: ${safeText(r.law)} 법령일련번호 ${safeText(i.amendment.oldMst)} → ${safeText(i.amendment.newMst)} (공포 ${safeText(i.amendment.promulgatedOn ?? "미상")}, 공포번호 ${safeText(i.amendment.promulgationNo || "미상")}, 시행 ${safeText(r.diff.effectiveOn ?? "미상")}); 바뀐 조문 단위 ${r.diff.unitCount}개`,
    `- 이전 버전을 찾은 방법: ${safeText(i.amendment.howFound)}`,
    `- 기간: ${safeText(r.windowStart)}(공포일)부터 ${safeText(r.asOf.slice(0, 10))}까지. 피어 방침의 시행일이 이 기간 안에 있어야 개정과 연결해 봅니다.`,
    "",
  );

  out.push("## 1. 그룹별 현황", "", "n은 개정 전후 버전을 모두 확인한 피어 수입니다. 아래 둘은 n에 넣지 않고 따로 셉니다.", "");
  out.push("| 그룹 | 활성 피어 | 비교 완료 n | 실질 변경 | 개정 전후 갱신 없음 | 이력 미공개 | 조회 불가·실패 |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const g of r.groups) out.push(`| ${safeText(g.nameKo)} | ${g.active} | ${g.compared} | ${g.changed} | ${g.noUpdate} | ${g.noHistory} | ${g.skipped + g.failed} |`);
  out.push("");

  out.push("## 2. 개정 조문과 함께 나타난 변경: 그룹별 k/n", "", `${PEER_SIGNAL_LABEL}. ${CO_OCCURRED_NOTE}`, "", "k는 같은 조문·항목에서 신뢰도 높음 또는 중간으로 연결된 피어 수입니다. 표시 기준(k 3 이상, k/n 60% 이상)을 못 채워도 참고로 모두 적습니다.", "");
  // One row per group, article and section (the 항/호 units of an article are listed in a parenthesis); k is the largest k among them.
  const rows = r.groups.flatMap((g) => {
    const by = new Map<string, { article: string; sectionId: string; list: (typeof g.signals)[number][] }>();
    for (const s of g.signals) {
      const article = splitArticleKey(s.articleKey).article;
      const cur = by.get(`${article}|${s.sectionId}`) ?? { article, sectionId: s.sectionId, list: [] };
      cur.list.push(s);
      by.set(`${article}|${s.sectionId}`, cur);
    }
    return [...by.values()].map((c) => {
      const confidence = bestConfidence(c.list.map((s) => s.confidence));
      const best = c.list.filter((s) => s.confidence === confidence);
      return { g, article: c.article, sectionId: c.sectionId, confidence, details: detailList(best.map((s) => s.articleKey)), k: Math.max(...c.list.map((s) => s.k)), n: c.list[0]!.n, meets: c.list.some((s) => s.meetsThreshold) };
    });
  });
  if (rows.length === 0) out.push("연결된 변경이 없습니다 (k = 0).", "");
  else {
    out.push("| 그룹 | 조문 (변경된 항·호) | 항목 | k / n | 신뢰도 | 표시 기준 충족 |", "| --- | --- | --- | --- | --- | --- |");
    for (const x of rows) out.push(`| ${safeText(x.g.nameKo)} | ${safeText(refLabel(x.article, x.details))} | ${title(x.sectionId)} | ${x.k} / ${x.n} | ${CONF_KO[x.confidence]} | ${x.meets ? "예" : "아니오"} |`);
    out.push("", "한 조문에서 여러 항·호가 연결된 경우 한 줄로 합쳤고, k는 그중 가장 큰 값입니다.", "");
  }

  out.push("## 3. 피어별 변경 (레지스트리 순서)", "");
  const compared = r.peers.filter((p) => p.status === "compared");
  const changed = compared.filter((p) => !p.cosmeticOnly && (p.changedSections?.length ?? 0) > 0);
  if (changed.length === 0) out.push("실질 변경이 확인된 피어가 없습니다.", "");
  for (const p of changed) {
    out.push(`- ${safeText(r.groups.find((g) => g.groupId === p.groupId)?.nameKo ?? p.groupId)} · ${safeText(p.name)} (${safeText(p.beforeDate ?? "?")} → ${safeText(p.afterDate ?? "?")})`);
    // Each changed section once, with its best confidence and the articles reached at that confidence.
    const refs = collapseAlignments(p.alignments ?? []);
    const seen = new Set<string>();
    const sections = (p.changedSections ?? []).filter((c) => !seen.has(c.sectionId) && !!seen.add(c.sectionId));
    if (refs.length === 0) out.push(`  - 연결 근거 없음: ${PEER_UNKNOWN_CAUSE_LABEL}`);
    const confLine = (sectionId: string): string => {
      const mine = refs.filter((x) => x.sectionId === sectionId);
      if (mine.length === 0) return PEER_UNKNOWN_CAUSE_LABEL;
      const best = bestConfidence(mine.map((x) => x.confidence));
      if (best === "low") return PEER_UNKNOWN_CAUSE_LABEL;
      return `신뢰도 ${CONF_KO[best]}: ${mine.filter((x) => x.confidence === best).map((x) => safeText(refLabel(x.article, x.details))).join(", ")}`;
    };
    for (const c of sections) out.push(`  - ${title(c.sectionId)} (${KIND_KO[c.kind]}) [${confLine(c.sectionId)}]${c.quote ? `: "${safeText(c.quote)}"` : ""}`);
    for (const id of new Set(refs.map((x) => x.sectionId))) if (!seen.has(id)) out.push(`  - ${title(id)} [${confLine(id)}]`);
  }
  if (changed.length > 0) out.push("");
  const same = compared.filter((p) => !changed.includes(p));
  if (same.length > 0) out.push(`개정 전후 버전은 확인했으나 실질 변경이 없는 피어: ${same.map((p) => safeText(p.name)).join(", ")}`, "");

  out.push("## 4. 집계에서 따로 센 피어", "");
  const part = (label: string, list: typeof r.peers): void => {
    out.push(`### ${label} (${list.length})`, "");
    if (list.length === 0) out.push("없음.", "");
    else {
      for (const p of list) out.push(`- ${safeText(p.name)}: ${safeText(p.reason ?? p.status)}`);
      out.push("");
    }
  };
  part("개정 전후 갱신 없음", r.peers.filter((p) => p.status === "no_update"));
  part("이력 미공개", r.peers.filter((p) => p.status === "no_history"));
  part("조회 불가·실패", r.peers.filter((p) => p.status === "skipped" || p.status === "failed"));

  out.push("---", "", PEER_SIGNAL_LABEL, "", CO_OCCURRED_NOTE, "", MONITOR_DISCLAIMER, "");
  return out.join("\n");
}
