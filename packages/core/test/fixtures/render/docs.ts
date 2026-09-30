/** Synthetic render fixtures. No real personal data. */
import type { PolicyAST, SectionAST, TermsAST } from "../../../src/contracts/ast";
import type { PiiVault } from "../../../src/contracts/pii-vault";
import type { AuditReport } from "../../../src/contracts/audit-report";

const trace = (slotRefs: string[] = [], citationIds: string[] = []) => ({ slotRefs, clauseRefs: [], ruleRefs: [], styleRefs: [], citationIds });
const meta = {
  runId: "20260929-101500-a1b2c3",
  effectiveDate: "2026-10-01",
  rulePackVersion: "rp-1.0.0",
  clauseLibVersion: "cl-0.3.0",
  houseStyleVersion: "hs-0.1.0",
  lawSnapshotId: "snap-20260929",
  promptVersions: { R5P: "1.2.0", R5T: "1.0.1" },
  models: { R5P: "claude-sonnet-5-5" },
};

const policySections: SectionAST[] = [
  {
    id: "S01",
    title: "개인정보의 처리 목적",
    status: "drafted",
    trace: trace(["privacy.S02_purposes"]),
    blocks: [
      { t: "para", runs: [{ t: "text", text: "회사는 다음의 목적을 위하여 개인정보를 처리합니다.", slotRef: "privacy.S02_purposes" }] },
      { t: "list", ordered: true, items: [[{ t: "text", text: "회원 가입 및 관리" }], [{ t: "text", text: "서비스 제공" }]] },
    ],
  },
  {
    id: "S02",
    title: "개인정보의 처리 및 보유 기간",
    status: "drafted",
    trace: trace([], ["PIPA-30"]),
    blocks: [{ t: "para", runs: [{ t: "text", text: "보유 기간은 " }, { t: "cite", citationId: "PIPA-30" }, { t: "text", text: "에 따라 정합니다." }] }],
  },
  {
    id: "S05",
    title: "개인정보 처리업무의 위탁",
    status: "drafted",
    trace: trace(["privacy.S09_processors"]),
    blocks: [
      {
        t: "table",
        caption: "수탁자 현황",
        header: ["수탁자", "위탁 업무", "보유 기간"],
        rows: [[[{ t: "text", text: "가나다 | 클라우드", slotRef: "privacy.S09_processors" }], [{ t: "text", text: "서버 운영" }], [{ t: "text", text: "계약 종료 시" }]]],
      },
      { t: "para", runs: [{ t: "link", text: "자세히 보기", href: "https://example.com/processors" }] },
    ],
  },
  { id: "S08", title: "국외 이전", status: "omitted_recommended", trace: trace(), blocks: [] },
  {
    id: "S10",
    title: "정보주체의 권리",
    status: "manual_review",
    trace: trace(),
    blocks: [{ t: "note", kind: "freshness", runs: [{ t: "text", text: "법령 개정 여부를 확인하십시오." }] }],
  },
  {
    id: "S12",
    title: "개인정보 보호책임자",
    status: "drafted",
    trace: trace(),
    blocks: [{ t: "para", runs: [{ t: "text", text: "성명: " }, { t: "placeholder", key: "PERSON_1" }, { t: "text", text: ", 연락처: {{PHONE_1}}, 이메일: {{EMAIL_9}}" }] }],
  },
  { id: "S13", title: "권익침해 구제방법", status: "not_applicable", trace: trace(), blocks: [] },
];

export const policyAst: PolicyAST = { docType: "privacy", meta, sections: policySections, warnings: [{ code: "W-SPECIAL", kind: "special_type", itemId: "S01", message: "민감정보 처리 가능성" }] };

export const termsAst: TermsAST = {
  docType: "terms",
  meta,
  warnings: [],
  sections: [
    { id: "T01", title: "목적", status: "drafted", trace: trace(), blocks: [{ t: "para", runs: [{ t: "text", text: "이 약관은 서비스 이용 조건을 정합니다." }] }] },
    { id: "T02", title: "정의", status: "drafted", trace: trace(), blocks: [{ t: "list", ordered: false, items: [[{ t: "text", text: "회원" }], [{ t: "text", text: "서비스" }]] }] },
    { id: "T03", title: "약관의 명시와 개정", status: "drafted", trace: trace([], ["ARTC-3"]), blocks: [{ t: "para", runs: [{ t: "cite", citationId: "ARTC-3" }, { t: "cite", citationId: "XXX-1" }] }] },
  ],
};

export const vault: PiiVault = {
  runId: meta.runId,
  entries: {
    PERSON_1: { kind: "person", value: "홍길동" },
    PHONE_1: { kind: "phone", value: "02-000-0000" },
  },
};

export const failAudit: AuditReport = {
  runId: meta.runId,
  docType: "privacy",
  iteration: 3,
  envelopeHash: "a".repeat(64),
  rubricVersion: "rb-1",
  profile: "privacy",
  scores: { legal: 3, accuracy: 4, clarity: 4, houseStyle: 3, consistency: 4 },
  verdict: "fail",
  resolvedFindingIds: [],
  findings: [{ id: "F1", layer: "llm", ruleId: "R-S02-001", docType: "privacy", sectionId: "S02", severity: "major", message: "보유 기간 근거 부족", evidence: { astPath: "sections[1].blocks[0]", quote: "보유 기간" }, fixHint: "근거 법령 추가" }],
};
