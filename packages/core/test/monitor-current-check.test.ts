import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockLlmClient, type StructuredCallRequest } from "../src/llm";
import { MonitorReportSchema } from "../src/contracts/monitor-report";
import { RULE_CLASSES, ruleClassOf } from "../src/stages/monitor/rule-classes";
import { checkCurrentPolicy, type CheckJudgeOutput } from "../src/stages/monitor";
import { inventedArticles } from "../src/stages/monitor/current-check";
import { ingestPolicy } from "../src/stages/ingest";
import { MON_RUN_ID, NOW, ingestFixture, kb, patterns, ruleSections } from "./monitor-fixtures";

const base = { runId: MON_RUN_ID, ruleSections, rulePackItems: kb.rulePackItems, rulePackVersion: kb.rulePackVersion, patterns, now: NOW };
const run = (name: string, llm?: MockLlmClient) => checkCurrentPolicy(llm ? { llm } : {}, { ...base, policy: ingestFixture(name) });
const sectionOf = (r: StructuredCallRequest): string => /^SECTION (\S+):/m.exec(r.user)![1]!;
const judge = (bySection: Record<string, CheckJudgeOutput["findings"]>) => new MockLlmClient({ fixtures: { M1: (r: StructuredCallRequest) => ({ findings: bySection[sectionOf(r)] ?? [] }) } });

describe("Mode A: deterministic part", () => {
  test("a clean policy has no findings and says the model judge did not run", async () => {
    const { report } = await run("policy-clean.md");
    expect(report.findings).toEqual([]);
    expect(report.llmUsed).toBe(false);
    expect(report.warnings.join(" ")).toContain("deterministic checks only");
    expect(MonitorReportSchema.safeParse(report).success).toBe(true);
  });

  test("a mandatory section absent from title AND text is Critical", async () => {
    const { report } = await run("policy-missing.md");
    const s06 = report.findings.find((f) => f.sectionId === "S06")!;
    const s11 = report.findings.find((f) => f.sectionId === "S11")!;
    expect([s06.severity, s11.severity]).toEqual(["critical", "critical"]);
    expect([s06.mode, s06.tier, s06.layer]).toEqual(["A", "confirmed", "deterministic"]);
    expect(report.summary.bySeverity.critical).toBe(2);
    // conditional sections that are absent (S04, S10, ...) are never reported as violations
    expect(report.findings.every((f) => ["S06", "S11"].includes(f.sectionId))).toBe(true);
  });

  test("a mandatory heading that is missing while the wording appears elsewhere is 'not located' (Confirm)", async () => {
    const { report } = await run("policy-unlabelled.md");
    const s06 = report.findings.filter((f) => f.sectionId === "S06");
    expect(s06).toHaveLength(1);
    expect(s06[0]!.severity).toBe("confirm");
    expect(s06[0]!.message).toContain("위치 미확인");
  });

  test("an empty summary heading whose topic sits under a combined heading elsewhere is Confirm, not High", async () => {
    // Real pages (2026-10-02 Lotte run): a summary label "개인정보의 보유 기간" with no body, while the retention text sits
    // under "처리하는 개인정보의 항목" further down.
    const clean = readFileSync(join(import.meta.dir, "fixtures", "monitor", "policy-clean.md"), "utf8");
    const content = clean.replace("## 3. 개인정보의 처리 및 보유 기간\n", "").replace("## 1. 개인정보의 처리 목적", "## 개인정보의 보유 기간\n\n## 1. 개인정보의 처리 목적");
    const policy = ingestPolicy({ name: "policy-toc.md", content, fetchedAt: NOW }, patterns);
    const { report } = await checkCurrentPolicy({}, { ...base, policy });
    const s05 = report.findings.filter((f) => f.sectionId === "S05");
    expect(s05.map((f) => [f.ruleId, f.severity])).toEqual([["C2-EMPTY", "confirm"]]);
    expect(s05[0]!.message).toContain("목차나 요약표");
  });

  test("an empty mandatory heading whose topic appears nowhere else stays High", async () => {
    const clean = readFileSync(join(import.meta.dir, "fixtures", "monitor", "policy-clean.md"), "utf8");
    const content = clean.replace("회사는 개인정보를 안전하게 처리하기 위하여 내부관리계획 수립, 접근권한 관리, 접속기록 보관, 암호화 등의 조치를 하고 있습니다.\n", "");
    const policy = ingestPolicy({ name: "policy-empty.md", content, fetchedAt: NOW }, patterns);
    const { report } = await checkCurrentPolicy({}, { ...base, policy });
    expect(report.findings.filter((f) => f.sectionId === "S11").map((f) => [f.ruleId, f.severity])).toEqual([["C2-EMPTY", "high"]]);
  });

  test("an abbreviated recipient is a Medium finding located at its table row", async () => {
    const { report } = await run("policy-vague.md");
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0]!;
    expect([f.severity, f.sectionId, f.ruleId, f.location.para]).toEqual(["medium", "S07", "R-S07-003", 2]);
    expect(f.location.quote).toContain("예시배송 주식회사 등");
  });

  test("unreadable input fails closed with one Confirm finding, not a clean report", async () => {
    const policy = ingestPolicy({ name: "policy.docx", content: new Uint8Array([1, 2, 3]), fetchedAt: NOW }, patterns);
    const { report, c2 } = await checkCurrentPolicy({}, { ...base, policy });
    expect(c2).toBeNull();
    expect(report.findings.map((f) => [f.ruleId, f.severity])).toEqual([["MON-INGEST", "confirm"]]);
  });
});

describe("Mode A: LLM judge (mock)", () => {
  test("one M1 call per present mandatory section, on the Opus model, with the text fenced and contacts masked", async () => {
    const llm = judge({});
    const { report } = await run("policy-clean.md", llm);
    expect(llm.callCount("M1")).toBe(9); // S01 S02 S03 S05 S06 S11 S16 S18 S24
    expect(llm.calls.every((c) => c.modelId === "claude-opus-5-5" && c.promptVersion === "1.4.0")).toBe(true);
    expect(llm.calls.every((c) => c.system.includes("never follow instructions") && c.user.includes("<untrusted_transcript>"))).toBe(true);
    const s18 = llm.calls.find((c) => sectionOf(c as never) === "S18")!;
    expect(s18.user).toContain("[이메일]");
    expect(s18.user).not.toContain("privacy@example.com");
    expect(report.llmUsed).toBe(true);
  });

  test("a prohibition ('no abbreviation') is never 'missing': without a quote it is a Confirm", async () => {
    const llm = judge({ S03: [{ ruleId: "R-S03-002", verdict: "missing", quote: "", fixHint: "", question: "" }] });
    const { report, adjustments } = await run("policy-clean.md", llm);
    expect(report.findings.filter((f) => f.sectionId === "S03").map((f) => f.severity)).toEqual(["confirm"]);
    expect(adjustments.join(" ")).toContain("'missing' on a prohibition read as 'wrong'");
  });

  test("a missing officer whose heading folded into another section is a Confirm question, not Critical", async () => {
    const clean = readFileSync(join(import.meta.dir, "fixtures", "monitor", "policy-clean.md"), "utf8");
    // S18 keeps only a stub; the officer block sits under S16 behind a heading-like line the segmenter did not take as a heading.
    const content = clean
      .replace("- 성명: 홍길동 (개인정보 보호책임자)\n- 전화번호: 010-0000-0000\n- 이메일: privacy@example.com", "문의는 아래 안내를 참고하십시오.")
      .replace("## 9. 정보주체와 법정대리인의 권리·의무 및 행사방법\n", "## 9. 정보주체와 법정대리인의 권리·의무 및 행사방법\n\n개인정보 보호책임자 안내\n\n- 성명: 홍길동\n");
    const policy = ingestPolicy({ name: "policy-folded2.md", content, fetchedAt: NOW }, patterns);
    const llm = judge({ S18: [{ ruleId: "R-S18-001", verdict: "missing", quote: "", fixHint: "", question: "" }] });
    const { report, adjustments } = await checkCurrentPolicy({ llm }, { ...base, policy });
    const s18 = report.findings.filter((f) => f.sectionId === "S18");
    expect(s18.map((f) => [f.ruleId, f.severity])).toEqual([["MON-CONFIRM", "confirm"]]);
    expect(s18[0]!.questions?.join(" ")).toContain("다른 부분에 관련 내용");
    expect(adjustments.join(" ")).toContain("reported as Confirm");
  });

  test("the model sees the policy's own headings and sub-headings (a right listed as a sub-heading is not 'missing')", async () => {
    const clean = readFileSync(join(import.meta.dir, "fixtures", "monitor", "policy-clean.md"), "utf8");
    const content = clean.replace("## 9. 정보주체와 법정대리인의 권리·의무 및 행사방법\n", "## 9. 정보주체와 법정대리인의 권리·의무 및 행사방법\n\n### 1) 개인정보 열람요구\n\n홈페이지에서 요구할 수 있습니다.\n");
    const policy = ingestPolicy({ name: "policy-sub.md", content, fetchedAt: NOW }, patterns);
    const llm = judge({});
    await checkCurrentPolicy({ llm }, { ...base, policy });
    const s16 = llm.calls.find((c) => sectionOf(c as never) === "S16")!;
    expect(s16.user).toContain("9. 정보주체와 법정대리인의 권리·의무 및 행사방법");
    expect(s16.user).toContain("1) 개인정보 열람요구");
  });

  test("retention 'missing' in S05 is a Confirm when an items table carries a retention column (real page, 2026-10-02)", async () => {
    const clean = readFileSync(join(import.meta.dir, "fixtures", "monitor", "policy-clean.md"), "utf8");
    const content = clean.replace("회사는 서비스 제공을 위하여 이름, 이메일 주소, 휴대전화번호, 배송지 주소를 처리합니다.", "| 목적 | 수집 항목 | 보유 및 이용기간 |\n| --- | --- | --- |\n| 회원 관리 | 이름, 이메일 | 탈퇴 시까지 |");
    const policy = ingestPolicy({ name: "policy-table.md", content, fetchedAt: NOW }, patterns);
    const llm = judge({ S05: [{ ruleId: "R-S05-001", verdict: "missing", quote: "", fixHint: "", question: "" }] });
    const { report } = await checkCurrentPolicy({ llm }, { ...base, policy });
    expect(report.findings.filter((f) => f.sectionId === "S05").map((f) => f.severity)).toEqual(["confirm"]);
  });

  test("a guideline-only must rule (no statutory ref) caps at Medium and says so; alerts use the Korean element label", async () => {
    // R-S01-006 cites only the drafting guideline (STDG:18(1)): PIPA 30(4) makes the guideline a recommendation.
    expect(ruleSections.get("S01")!.rules.find((r) => r.ruleId === "R-S01-006")!.legalRefs.every((k) => k.startsWith("STDG:"))).toBe(true);
    const llm = judge({
      S01: [{ ruleId: "R-S01-006", verdict: "wrong", quote: "예시몰 개인정보 처리방침", fixHint: "x", question: "" }],
      S05: [{ ruleId: "R-S05-005", verdict: "wrong", quote: "회원 정보는 회원 탈퇴 시까지 보유합니다.", fixHint: "y", question: "" }],
    });
    const { report } = await run("policy-clean.md", llm);
    const s01 = report.findings.find((f) => f.ruleId === "R-S01-006")!;
    expect(s01.severity).toBe("medium");
    expect(s01.message).toContain("작성지침 권고 사항");
    const s05 = report.findings.find((f) => f.ruleId === "R-S05-005")!;
    expect(s05.severity).toBe("high"); // PIPA:30(1)2 since the self-review
    expect(s05.message.startsWith("업무별 구체적 보유기간:")).toBe(true);
    expect(s05.message).not.toContain("작성지침 권고");
  });

  test("self-review 2026-10-03: S05 judge sees retention-column rows; web pages say so; empty textOnly confirms drop; invented article numbers are replaced", async () => {
    const clean = readFileSync(join(import.meta.dir, "fixtures", "monitor", "policy-clean.md"), "utf8");
    const content = clean.replace("회사는 서비스 제공을 위하여 이름, 이메일 주소, 휴대전화번호, 배송지 주소를 처리합니다.", "| 목적 | 수집 항목 | 보유 및 이용기간 |\n| --- | --- | --- |\n| 회원 관리 | 이름, 이메일 | 탈퇴 후 30일 |");
    const policy = ingestPolicy({ name: "policy-table.md", content, fetchedAt: NOW }, patterns);
    const llm = judge({
      S05: [{ ruleId: "R-S05-005", verdict: "wrong", quote: "회원 정보는 회원 탈퇴 시까지 보유합니다.", fixHint: "제99조에 따라 기간을 적으십시오.", question: "" }],
      S01: [{ ruleId: "R-S01-006", verdict: "confirm", quote: "", fixHint: "", question: "" }],
    });
    const { report, adjustments } = await checkCurrentPolicy({ llm }, { ...base, policy });
    const s05call = llm.calls.find((c) => sectionOf(c as never) === "S05")!;
    expect(s05call.user).toContain("[관련 표: 처리 목적·항목 표의 보유기간 열]");
    expect(s05call.user).toContain("탈퇴 후 30일");
    expect(s05call.user).not.toContain("SOURCE: a privacy policy page"); // Markdown file: not known to be a web page
    const f = report.findings.find((x) => x.ruleId === "R-S05-005")!;
    expect(f.fixHint).not.toContain("제99조");
    expect(adjustments.join(" ")).toContain("fix hint cited 제99조");
    expect(report.findings.some((x) => x.ruleId === "R-S01-006" || (x.ruleIds ?? []).includes("R-S01-006"))).toBe(false);
    expect(adjustments.join(" ")).toContain("answered 'confirm' without a question");
    expect(inventedArticles("법 제35조의2와 제37조를 보십시오", ["PIPA:35-2(1)"], "제37조에 따라")).toEqual([]);
    expect(inventedArticles("제12조를 보십시오", ["PIPA:30(1)5"], "")).toEqual(["제12조"]);
    const html = ingestPolicy({ name: "p.html", content: "<h2>1. 개인정보의 처리 목적</h2><p>회원 관리에 이용합니다.</p>", fetchedAt: NOW }, patterns);
    const llm2 = judge({});
    await checkCurrentPolicy({ llm: llm2 }, { ...base, policy: html });
    expect(llm2.calls.every((c) => c.user.includes("SOURCE: a privacy policy page published on the operator's website"))).toBe(true);
  });

  test("verdicts map to severities; a missing must element is High (Critical is for an absent section), a located wrong value High, should-level Low", async () => {
    const llm = judge({
      S05: [
        { ruleId: "R-S05-001", verdict: "missing", quote: "", fixHint: "보유 기간의 근거를 적으십시오.", question: "" },
        { ruleId: "R-S05-005", verdict: "wrong", quote: "회원 정보는 회원 탈퇴 시까지 보유합니다.", fixHint: "구체적 기간을 적으십시오.", question: "" },
        { ruleId: "R-S05-002", verdict: "ok", quote: "", fixHint: "", question: "" },
      ],
      S01: [{ ruleId: "R-S01-002", verdict: "missing", quote: "", fixHint: "제목에 처리자 이름을 넣으십시오.", question: "" }],
    });
    const { report } = await run("policy-clean.md", llm);
    const bySev = Object.fromEntries(report.findings.map((f) => [f.ruleId, f.severity]));
    expect(bySev).toEqual({ "R-S05-001": "high", "R-S05-005": "high", "R-S01-002": "low" });
    const wrong = report.findings.find((f) => f.ruleId === "R-S05-005")!;
    expect([wrong.layer, wrong.tier, wrong.location.sectionId, wrong.location.para]).toEqual(["llm", "confirmed", "S05", 1]);
    expect(wrong.location.quote).toBe("회원 정보는 회원 탈퇴 시까지 보유합니다.");
    // sorted: critical first, ids numbered
    expect(report.findings.map((f) => f.id)).toEqual(["A-0001", "A-0002", "A-0003"]);
    expect(report.findings[0]!.ruleId).toBe("R-S05-001");
  });

  test("a fabricated quote drops the finding; unknown rule ids are dropped too", async () => {
    const llm = judge({
      S05: [
        { ruleId: "R-S05-005", verdict: "wrong", quote: "이 문장은 처리방침에 존재하지 않습니다.", fixHint: "x", question: "" },
        { ruleId: "R-S99-001", verdict: "missing", quote: "", fixHint: "x", question: "" },
      ],
    });
    const { report, adjustments } = await run("policy-clean.md", llm);
    expect(report.findings).toEqual([]);
    expect(adjustments.join("\n")).toContain("not a verbatim substring");
    expect(adjustments.join("\n")).toContain("R-S99-001");
  });

  test("fact-dependent rules never exceed Confirm, whatever the judge says; Confirm items merge per section", async () => {
    const q = (ruleId: string, verdict: "missing" | "wrong" | "confirm", question = ""): CheckJudgeOutput["findings"][number] => ({ ruleId, verdict, quote: "", fixHint: "x", question });
    const llm = judge({
      S03: [q("R-S03-005", "missing", "서비스 이용 중 생성되는 정보가 있습니까?"), q("R-S03-003", "missing", "동의 없이 처리하는 항목이 있습니까?"), q("R-S03-007", "confirm", "고유식별정보가 있습니까?"), q("R-S03-006", "confirm")],
      S24: [q("R-S24-002", "missing", "이전 버전이 있습니까?")],
      S16: [q("R-S16-005", "missing"), q("R-S16-001", "missing")],
    });
    const { report, adjustments } = await run("policy-clean.md", llm);
    const s03 = report.findings.filter((f) => f.sectionId === "S03");
    expect(s03).toHaveLength(1);
    expect([s03[0]!.severity, s03[0]!.ruleId, s03[0]!.ruleIds]).toEqual(["confirm", "MON-CONFIRM", ["R-S03-003", "R-S03-005", "R-S03-006"]]);
    expect(s03[0]!.questions!.join("\n")).toContain("생성되는 정보");
    expect(adjustments.join("\n")).toContain("R-S03-007"); // should-level Confirm is dropped
    expect(report.findings.filter((f) => f.sectionId === "S24").map((f) => f.severity)).toEqual(["confirm"]);
    const s16 = report.findings.filter((f) => f.sectionId === "S16");
    expect(s16.map((f) => [f.ruleId, f.severity])).toEqual([["R-S16-001", "high"], ["MON-CONFIRM", "confirm"]]);
    expect(report.summary.bySeverity.critical).toBe(0);
  });

  test("clean policy with a noisy judge: no Critical/High and at most one should-level item", async () => {
    const q = (ruleId: string, verdict: "missing" | "wrong" | "confirm"): CheckJudgeOutput["findings"][number] => ({ ruleId, verdict, quote: "", fixHint: "x", question: "q" });
    const llm = judge({ S03: [q("R-S03-005", "missing"), q("R-S03-006", "missing")], S05: [q("R-S05-003", "wrong"), q("R-S05-004", "confirm")], S16: [q("R-S16-005", "missing"), q("R-S16-006", "missing")], S24: [q("R-S24-002", "missing"), q("R-S24-004", "missing"), q("R-S24-003", "confirm")], S01: [q("R-S01-002", "missing")] });
    const { report } = await run("policy-clean.md", llm);
    const { critical, high, low } = report.summary.bySeverity;
    expect([critical, high]).toEqual([0, 0]);
    expect(low).toBeLessThanOrEqual(1);
  });

  test("policy-missing: the two missing mandatory sections stay Critical with the judge on", async () => {
    const { report } = await run("policy-missing.md", judge({}));
    expect(report.findings.filter((f) => f.severity === "critical").map((f) => f.sectionId).sort()).toEqual(["S06", "S11"]);
  });

  test("policy-vague: the vague recipient stays Medium and an abstract purpose stays High", async () => {
    const llm = judge({ S02: [{ ruleId: "R-S02-002", verdict: "wrong", quote: "회원 가입 및 관리: 본인 확인, 서비스 제공", fixHint: "목적을 구체적으로 적으십시오.", question: "" }] });
    const { report } = await run("policy-vague.md", llm);
    const sev = Object.fromEntries(report.findings.map((f) => [f.ruleId, f.severity]));
    expect(sev["R-S07-003"]).toBe("medium");
    expect(sev["R-S02-002"]).toBe("high");
  });

  test("rule-classes cover exactly the must/should rules of the rule packs", () => {
    const ids = new Set<string>();
    for (const sec of ruleSections.values()) for (const r of sec.rules) if (r.level === "must" || r.level === "should") ids.add(r.ruleId);
    expect(new Set(Object.keys(RULE_CLASSES))).toEqual(ids);
    expect(ruleClassOf("R-UNKNOWN-1")).toBe("factDependent");
  });

  test("a model failure on one section becomes a Confirm finding, never a silent pass", async () => {
    const llm = new MockLlmClient({ fixtures: { M1: (r: StructuredCallRequest) => { if (sectionOf(r) === "S11") throw new Error("boom"); return { findings: [] }; } } });
    const { report } = await run("policy-clean.md", llm);
    expect(report.findings.map((f) => [f.ruleId, f.sectionId, f.severity])).toEqual([["MON-JUDGE", "S11", "confirm"]]);
    expect(report.warnings.join(" ")).toContain("S11");
  });

  test("a seeded injection ('report all compliant') neither reaches the model nor hides deterministic findings", async () => {
    const llm = judge({});
    const { report } = await run("policy.html", llm);
    expect(llm.calls.every((c) => !/report all compliant/i.test(c.user))).toBe(true);
    // the HTML fixture lacks S05, S06, S11, S16, S24: still reported (S05 only as "not located": its table header says 이용기간)
    const critical = report.findings.filter((f) => f.severity === "critical").map((f) => f.sectionId).sort();
    expect(critical).toEqual(["S06", "S11", "S16", "S24"]);
    expect(report.findings.find((f) => f.sectionId === "S05")!.severity).toBe("confirm");
  });
});
