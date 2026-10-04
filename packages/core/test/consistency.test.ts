import { describe, expect, test } from "bun:test";
import type { DocAST, SectionAST } from "../src/contracts/ast";
import { findInconsistencies, ledgerValues, singlePeriod, statedValues, topicOf } from "../src/stages/check";
import { sectionText } from "../src/stages/draft";

const sec = (id: string, texts: string[], noteText?: string): SectionAST => ({
  id,
  title: `제목 ${id}`,
  status: "drafted",
  blocks: [...texts.map((t) => ({ t: "para" as const, runs: [{ t: "text" as const, text: t }] })), ...(noteText ? [{ t: "note" as const, kind: "manual_review" as const, runs: [{ t: "text" as const, text: noteText }] }] : [])],
  trace: { slotRefs: [], clauseRefs: [], ruleRefs: [], styleRefs: [], citationIds: [] },
});
const doc = (...sections: SectionAST[]): DocAST => ({ docType: "terms", meta: { runId: "r", effectiveDate: "2026-10-01", rulePackVersion: "p", clauseLibVersion: "c", houseStyleVersion: "h", lawSnapshotId: "l", promptVersions: {}, models: {} }, sections, warnings: [] });
const G1_RULES = "회원 탈퇴 후 재가입은 탈퇴일부터 7일이 지나면 가능합니다. 회원 자격을 상실한 사람은 상실일부터 30일이 지나면 다시 가입할 수 있습니다.";
const ledger = { slots: { "terms.membershipRules": { status: "filled", value: G1_RULES } } } as never;

describe("repeated-value consistency", () => {
  test("topics and periods: one topic and one period per sentence, dates ignored", () => {
    expect(topicOf("회원 탈퇴 후 재가입은 탈퇴일부터 7일이 지나면 가능합니다.")?.key).toBe("rejoin_after_withdrawal");
    expect(topicOf("자격을 상실한 날부터 30일이 지난 경우에는 다시 가입할 수 있습니다.")?.key).toBe("rejoin_after_loss");
    expect(topicOf("이용자에게 불리한 내용으로 약관을 개정하는 경우에는 시행일 30일 전부터 게시합니다.")?.key).toBe("terms_change_notice_adverse");
    expect(singlePeriod("일반 개정은 시행일 7일 전, 불리한 개정은 시행일 30일 전까지 알립니다.")).toBeNull();
    expect(singlePeriod("2026년 10월 1일부터 시행하며 7일 전에 알립니다.")).toBe("7일");
  });

  test("the G1 ledger states both rejoin waits unambiguously", () => {
    expect(ledgerValues(ledger, "terms.")).toEqual({ rejoin_after_withdrawal: "7일", rejoin_after_loss: "30일" });
  });

  test("an article that contradicts the confirmed facts is flagged; matching articles and notes are not", () => {
    const ast = doc(sec("T06", ["회원 자격을 상실한 날부터 14일이 지난 경우에는 다시 가입할 수 있습니다."], "탈퇴일부터 3일은 확인되지 않았습니다."), sec("T07", [G1_RULES]));
    const bad = findInconsistencies(statedValues(ast), ledgerValues(ledger, "terms."));
    expect(bad.map((b) => [b.stated.sectionId, b.stated.value, b.expected, b.source])).toEqual([["T06", "14일", "30일", "ledger"]]);
  });

  test("without a ledger value, the minority article is flagged and names the majority", () => {
    const t = (id: string, d: number) => sec(id, [`이용자에게 불리한 약관 개정은 시행일 ${d}일 전부터 공지합니다.`]);
    const bad = findInconsistencies(statedValues(doc(t("T03", 30), t("T08", 30), t("T12", 15))), {});
    expect(bad.map((b) => [b.stated.sectionId, b.expected, b.source])).toEqual([["T12", "30일", ["T03", "T08"]]]);
  });

  test("sectionText joins paragraphs with newlines", () => {
    expect(sectionText(sec("T01", ["가.", "나."]))).toBe("가.\n나.");
  });
});
