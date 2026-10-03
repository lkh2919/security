# Domain self-review: real Lotte run, rule classes, legal refs, wording (2026-10-02)

> **AI 자체 검토 — 사람 전문가 검증 전.** Written by the privacy-domain-expert role (claude-opus-5-5) at PM dispatch.
> This is not a human expert sign-off and not legal advice. Reference draft. InfoSec and legal review required.

## Sources

| Source | Status |
|---|---|
| 개인정보 보호법, 법률 제21445호 (MST 283839), law.go.kr DRF lawService XML | verified 2026-10-02 (PM fetch) |
| 개인정보 보호법 시행령, 대통령령 제36671호 (MST 289537), `https://www.law.go.kr/DRF/lawService.do?target=law&type=XML&MST=289537` | fetched and verified 2026-10-02 (this review) |
| Raw pages `watch/lotte/*.html`; reports in `runs/lotte-real/` | read 2026-10-02 |
| PIPC Privacy Policy Drafting Guideline 2026.4 | **not available** in this container (`kb/_sources/` absent). Guideline line refs are taken from the rule pack as is. |

Article texts used below are from those two XML files. Anything else is marked ⚠️ Unverified.

## 1. Verdicts on the 42 findings

Labels: `golden/monitor/real-run-labels-2026-10-02.json` (ids and reasons only, no page quotes, no contacts).
Each finding has two verdicts. `verdict` judges against the law as it applies today. `rulePackVerdict` judges against the rule statement exactly as written in privacy-2026.04.

| Set | TP | FP | uncertain | Precision TP/(TP+FP) |
|---|---|---|---|---|
| All 42 (39 High, 2 Medium A, 1 Medium B), law today | 29 | 5 | 8 | **85.3%** |
| 39 High only, law today | 26 | 5 | 8 | **83.9%** |
| All 42, rule pack as written | 37 | 4 | 1 | 90.2% |
| 39 High, rule pack as written | 34 | 4 | 1 | 89.5% |

By rule (law today):

| Rule | n | TP | FP | unc. | Note |
|---|---|---|---|---|---|
| R-S06-003 | 10 | 10 | 0 | 0 | All have a procedure and a method. None says who selects and approves. Guideline detail only: severity should not be High (see 2a). |
| R-S16-001 | 10 | 1 | 2 | 7 | 렌탈 TP (no deletion or suspension right). 캐슬 FP (lists 전송, states no automated decisions, gives a channel). 웰푸드 FP (only 전송 missing). 7 uncertain: core rights present, only 35-2 / 37-2 missing (see 2b). |
| R-S02-002 | 5 | 4 | 1 | 0 | 건설 FP: summary label with "see body" pointer; body is specific. |
| R-S03-002 | 5 | 5 | 0 | 0 | |
| R-S05-005 | 4 | 3 | 1 | 0 | 캐슬 FP: period ends at a named event (eligibility screening). |
| R-S01-006 | 2 | 2 | 0 | 0 | Real, but drafting quality; Medium fits. |
| R-S01-001 | 1 | 0 | 0 | 1 | 하이마트몰: static HTML has no title above the version selector; check the rendered page. |
| R-S06-001 | 1 | 1 | 0 | 0 | 웰푸드 omits "지체 없이". |
| R-S05-001 | 1 | 0 | 1 | 0 | L.POINT: record type and statute are present; list split into A./B. lines misled the model. |
| R-S07-003 (Medium) | 2 | 2 | 0 | 0 | |
| Mode B S18 (Medium) | 1 | 1 | 0 | 0 | L.POINT duty list lacks PIPA 31(4)2-3. Real, but it is R-S18-006 (should), reported under R-S18-001. |

Severity correctness matters as much as precision. Of the 26 High TPs, 12 should not be High under the 2a decision (10× R-S06-003, 2× R-S01-006).

FP causes worth fixing in code (automation-engineer): A./B. list lines split from their parent item (L.POINT S05); summary labels with a pointer to the body (건설 S02).

## 2. Decisions

### 2a. Guideline-only `must` rules

**Decision: yes, cap at Medium.** A `must` rule with empty `legalRefs` reports at most Medium in Mode A. High needs a verified statutory duty.

Reasoning:
- PIPA 30(4): PIPC "작성지침을 정하여 … 준수를 권장할 수 있다". The guideline is a recommendation. Breaking it alone is not a breach of the Act.
- PIPA 30-2(1)1-2: PIPC evaluates whether the required items are "적정하게" stated and the policy is "알기 쉽게" written, and may recommend improvement. That supports Medium for clarity and specificity, not High.
- High tells InfoSec "the text fails the law". The monitor should only say that with a verified article.

R-S06-003 specifically: PIPA 30(1)3의2 requires "개인정보의 파기절차 및 파기방법". That supports the existence of a procedure and a method. Neither PIPA 21 nor Decree 16 requires naming who selects and approves. Decree 16(1) sets the method only (electronic files: unrecoverable permanent deletion; other media: shredding or incineration); 16(2) delegates details to a PIPC notice. Whether the safety-measures notice (고시 제2026-9호) requires an approval record: ⚠️ Unverified (text not read).

Proposed split (do not apply yet):

```json
{"ruleId":"R-S06-003","sectionId":"S06","level":"must","element":"procedure and method stated","statement":"State the destruction procedure and the destruction method (electronic files made unrecoverable; other media shredded or incinerated).","legalRefs":["PIPA:30(1)3-2","PIPA:21(2)","DEC:16(1)"],"check":{"kind":"deterministic","expr":"exists(section.S06.procedure) && exists(section.S06.method)"}}
{"ruleId":"R-S06-005","sectionId":"S06","level":"should","element":"selection and approval step","statement":"Describe the procedure concretely: who selects data due for destruction and who approves it (for example the privacy officer).","legalRefs":[],"check":{"kind":"llm"}}
```

Class: R-S06-003 textOnly; R-S06-005 textOnly (should → Low). Effect on this run: 10 High → 10 Low.

All 32 `must` rules with empty `legalRefs` (Decree refs below are from the verified Decree XML):

| Rule | Class now | Recommendation |
|---|---|---|
| R-S02-002 specific purposes | textOnly | **Keep High; add `PIPA:3(1)`** ("처리 목적을 명확하게"), `PIPA:30(1)1` |
| R-S02-003 matches consent notice | factDependent | Confirm only; add `PIPA:15(2)1` later |
| R-S02-004 no-consent purposes predictable | factDependent | Confirm only |
| R-S03-002 no abbreviated items | textOnly | **Keep High; add `DEC:31(1)1`** (items are a policy item). Catch-all "등/기타" = item not stated. Abstract-but-named labels are a human call |
| R-S03-003 consent vs no-consent split | factDependent | Confirm only |
| R-S03-005 generated data | factDependent | Confirm only |
| R-S03-006 data from others | factDependent | Confirm only |
| R-S03-008 on-device with server storage | factDependent | Confirm only |
| R-S04-003 child-readable wording | textOnly | **Add `PIPA:22-2(3)`** ("이해하기 쉬운 양식과 명확하고 알기 쉬운 언어"); keep High |
| R-S05-002 period matches consent notice | factDependent | Confirm only |
| R-S05-003 statute and period for legal retention | factDependent | **Add `PIPA:30(1)3-2`** (보존근거, 항목); see reclass in §3 |
| R-S05-005 concrete period per task | textOnly | **Keep High; add `PIPA:30(1)2`**. Human check: is "목적 달성 시" no period at all? |
| R-S05-007 HR retention table | factDependent | Confirm only |
| R-S06-003 procedure detail | textOnly | **Split** as above |
| R-S07-003 recipients named | textOnly | **Cap Medium** (as the deterministic path already does); add `PIPA:30(1)3`, `PIPA:17(2)1` for drafting |
| R-S09-002 processors named | textOnly | **Cap Medium**; add `PIPA:26(2)`, `PIPA:30(1)4` (26(2): 수탁자 must be easy to check) |
| R-S10-001 overseas described separately | textOnly | **Cap Medium** (layout rule) |
| R-S10-004 all countries (cloud) | factDependent | Confirm only; add `PIPA:28-8(2)` later |
| R-S10-005 other-law basis named | factDependent | Confirm only; `PIPA:28-8(1)2` |
| R-S10-007 re-transfer after direct collection | factDependent | Confirm only |
| R-S11-002 actual measures | factDependent | Confirm only |
| R-S13-005 pseudonymized outsourcing | factDependent | Confirm only |
| R-S14-002 refusal steps | textOnly | **Keep High; add `PIPA:30(1)7`** ("그 거부에 관한 사항") |
| R-S14-003 identified behavioral data | factDependent | Confirm only |
| R-S14-007 collection on third-party sites | factDependent | Confirm only |
| R-S16-002 website self-service | factDependent | **Add `PIPA:38(4)`, `DEC:41(2)3`** (homepage operators publish the request method on the homepage); see reclass |
| R-S18-003 working contact | factDependent | Confirm only |
| R-S19-002 reachable Korean phone | factDependent | Confirm only |
| R-S20-002 current contacts | factDependent | Confirm only |
| R-S23-003 claims are true | factDependent | Confirm only |
| R-S24-002 prior versions | factDependent | Confirm only (guideline) |
| R-S24-004 comparison table | factDependent | Confirm only (guideline) |

Also cap Medium: R-S01-006 (its only ref `STDG:18(1)` is ⚠️ Unverified against 고시 제2025-4호; PIPA 30-2(1)2 is an evaluation criterion, not a duty).

Code change for automation-engineer: in `current-check.ts`, cap severity at Medium when `rule.legalRefs` is empty, mirroring the `upcoming` cap. Rule-pack edits by this role after a human approves this section.

### 2b. Split of R-S16-001

**Decision: split.** Keep R-S16-001 textOnly for the core rights only. 전송요구권 and automated decisions become fact-dependent.

Basis (PIPA 21445 and Decree 36671 XML):
- PIPA 35-2(1): the transmission right applies only to processors meeting the Decree criteria.
- Decree 42-2(1): 본인대상정보전송자 = (1) average revenue over KRW 180B **and** sensitive/unique-ID data of 50k+ or personal data of 1M+ subjects; (2) public system operators; (3) third-party transmitters (42-2(2): health, telecom, energy). Item (1) is **in force from 2027-02-20** (XML note "[시행일: 2027.2.20] 제42조의2제1항제1호"; Decree 36121 부칙). So today no affiliate in this run is a transmitter unless it is a public system operator or in those three sectors (⚠️ fact not verified per affiliate). From 2027-02-20 most large affiliates likely qualify.
- PIPA 37-2(1)-(2): refusal and explanation rights exist only where fully automated decisions are made. Decree 44-4(1)5 requires publishing the method only then.
- PIPA 38(1) and 38(4): the procedure must cover every 열람등요구 that applies, including 35-2 and 37-2 where they apply. PIPA 37(1) makes consent withdrawal a core right.

Existing rules already hold the conditional parts: R-S16-005 (transmitter, factDependent) and S17 (conditional on `gate.automatedDecision`, R-S17-005). R-S16-001 duplicated them unconditionally.

Proposed JSON (do not apply yet):

```json
{"ruleId":"R-S16-001","sectionId":"S16","level":"must","element":"core rights and how to exercise","statement":"State the rights and duties of data subjects and legal representatives and, concretely, how and through which procedure to exercise access, correction or deletion, processing suspension and consent withdrawal. The procedure must not be harder than the collection channel.","legalRefs":["PIPA:30(1)5","PIPA:35(1)","PIPA:36(1)","PIPA:37(1)","PIPA:38(4)"],"check":{"kind":"deterministic","expr":"has(section.S16.rights, ['access','correction_deletion','suspension','withdrawal']) && exists(section.S16.procedure)"}}
{"ruleId":"R-S16-005","sectionId":"S16","level":"must","element":"transmission request (if transmitter)","statement":"If the processor is an information transmitter under Decree 42-2, state how to request transmission to oneself and how to check transmission status and history; for third-party transmission, say it is requested via the recipient's service and that recipient lists and request status are on the national transmission support platform.","legalRefs":["PIPA:35-2(1)","PIPA:35-2(2)","DEC:42-2(1)","DEC:42-2(2)","DEC:42-6(5)"],"check":{"kind":"deterministic","expr":"if(slot(gate.dataPortabilitySender)) exists(section.S16.portability.self) && exists(section.S16.portability.thirdParty)"},"effectiveNote":"Decree 42-2(1)1 (large private processors) in force 2027-02-20 (verified 2026-10-02, MST 289537 조문참고자료); items 2-3 already in force."}
{"ruleId":"R-S16-008","sectionId":"S16","level":"should","element":"automated-decision rights pointer","statement":"Where the processor makes fully automated decisions (PIPA 37-2), list refusal and explanation requests among the rights and point to the S17 section for the method; where none are made, a short statement that none are made is recommended.","legalRefs":["PIPA:37-2(1)","PIPA:37-2(2)","PIPA:38(1)","DEC:44-4(1)5"],"check":{"kind":"llm"}}
```

Classes: R-S16-001 textOnly; R-S16-005 factDependent (unchanged); R-S16-008 factDependent (should, so dropped from Mode A per the class rules). R-S16-005 `DEC:42-6(5)` content not re-read here (⚠️ Unverified detail).
Effect on this run: 10 High → 1 High (렌탈) + Confirm items. Add a Mode B scheduled alert for S16 before 2027-02-20 (see §4).

## 3. Rule-class changes (`rule-classes.ts`)

Only rules I would reclassify or narrow:

| Rule | Now | Proposed | Reason |
|---|---|---|---|
| R-S16-001 | textOnly | textOnly **after the 2b split**; factDependent if not split | As written it contains two conditional rights. |
| R-S16-002 | factDependent | textOnly for web-fetched policies | The condition "a website is operated" is proven by the fetch. Drop "transmission" from its statement (conditional). |
| R-S05-003 | factDependent | textOnly | The trigger is in the text: when the policy says it keeps data "under related laws", the statute and period must be there (PIPA 30(1)3의2 parenthetical). The 10/10 "관련 법령에 의한 사유에 따라 일정 기간" wording is the real legal gap, more than R-S06-003. |
| R-S06-002 | factDependent | textOnly **once the judge also sees S05 text** | Same trigger and basis; the rule allows a pointer to S05, so a one-section judge would give false positives today. |
| R-S18-006 | factDependent | textOnly (should → Low) | Trigger is textual (a duty list is present); compare with the verified PIPA 31(4) list. Would catch the L.POINT case in Mode A. |
| R-S12-001 | textOnly | factDependent | Applies only "if public information may include sensitive data": an operator fact. |
| R-S06-005 (new) | — | textOnly | From the 2a split. |
| R-S16-008 (new) | — | factDependent | From the 2b split. |

Check-expression note (not a class change): R-S01-001 regex `/개인정보 처리방침/` needs the space; most real titles are "개인정보처리방침". Accept `/개인정보\s*처리\s*방침/`.

## 4. Legal-ref map (`statutes/legalref-map.json`)

| # | Problem | Fix |
|---|---|---|
| 1 | `DEC.scheduled` is `[]` but Decree 42-2(1)1 takes effect 2027-02-20 inside the current text (verified, see 2b). Mode B will not warn S16 in time. | Add `{"key":"DEC:42-2(1)1","effectiveDate":"2027-02-20","source":"대통령령 제36121호 부칙 단서"}`; map to R-S16-005. |
| 2 | Generic aliases are shared: "법" (12 prefixes), "시행령"/"영" (DEC, ECA-DEC, NETA-DEC, CIA-DEC), "고시" (STDG, SAFE), "보호법" (PIPA). | Mark them context-only (resolve against the law cited nearby), never global. |
| 3 | `PIPA:31` (whole article) on R-S18-001 maps every Art. 31 change to a `must` rule. The L.POINT Mode B finding came out as R-S18-001 though the content is R-S18-006. | Rule-pack fix: R-S18-001 → `PIPA:31(1)`, `PIPA:30(1)6`. |
| 4 | PIPCGL is `mapped` but no rule key uses it; a new guideline edition maps by key to nothing. | Confirm code honours `affectsAllSections`, or set a distinct mode. |
| 5 | NETA and NETA-DEC are `mapped` with no rule refs; every change ends UNMAPPED. | Works, but the mode name misleads. Note it or use `unmappedOnly`. |
| 6 | STDG article refs (`STDG:18(1)`, `STDG:20(1)`) are verified only at notice level (고시 제2025-4호), not article text. | ⚠️ Unverified; fetch the admrul text before relying on them. |
| 7 | PIPA scheduled stage 2027-07-01 (MST 283839) | Verified: XML `조문시행일자문자열` = 32-2(1) 단서, 75(2)15. PIPA 289415 (법률 제21910호, 2027-03-09): ⚠️ Unverified here. |
| 8 | Finance prefixes (CIA, CIA-DEC, EFTA, FCPA) `manualReview` | Correct per design C6. No change. |

## 5. Alert wording (old → new)

`current-check.ts`, LLM findings. Needs a Korean element label (`elementKo`) per rule; proposed labels for the rules that fired are below.

| Where | Old | New |
|---|---|---|
| wrong | `규칙 ${ruleId}: 요구 요소(${element})의 기재가 규칙과 다릅니다.` | `${elementKo}: 기재 내용이 작성 기준에 맞지 않는 것으로 보입니다 (규칙 ${ruleId}).` |
| missing | `규칙 ${ruleId}: 요구 요소(${element})가 확인되지 않습니다.` | `${elementKo}: 이 항목에서 찾지 못했습니다 (규칙 ${ruleId}). 다른 위치에 있으면 '해당 없음'으로 표시하십시오.` |
| C2-M critical | `필수 항목 ${id}(${title})이(가) 처리방침에 없습니다. 제목과 본문 전체에서 관련 표현을 찾지 못했습니다.` | `필수 기재사항 '${title}'이(가) 처리방침에서 확인되지 않습니다 (제목·본문 검색 결과 없음).` |
| vague recipients | `제공받는 자 또는 수탁자가 '등' 등으로 줄여 적혀 있습니다. 각각 구체적으로 적어야 합니다.` | `제공받는 자(또는 수탁자) 목록이 '등'으로 끝나거나 묶음 명칭으로 적혀 있습니다. 업체명을 모두 적어야 합니다.` |
| vague recipients fixHint | `모든 제공받는 자 또는 수탁자를 명시하십시오.` | `'등'을 지우고 업체를 모두 적거나, 전체 목록을 볼 수 있는 화면·링크를 안내하십시오.` |
| guideline-only cap (new) | — | append ` (작성지침 권고 사항이며 법 조문 위반으로 단정하지 않습니다.)` when capped by 2a |

`impact.ts`, Mode B:

| Where | Old | New |
|---|---|---|
| provisional | `개정으로 인해 변경이 필요할 수 있습니다(가능성, 미검증). 개정 조문: ${keys}.` (25 keys listed) | `${lawKo} 제${article}조 개정(${effectiveOn} 시행)으로 이 항목의 수정이 필요할 수 있습니다 (미검증). 개정 범위: ${compactKeys}.` with keys compacted per article, e.g. `제31조 제1항, 제3항~제10항` |
| MON-UNMAPPED | `개정 조문 ${u.key}(${u.change})은(는) …` (leaks `amended/added/deleted`) | map change: amended→`개정`, added→`신설`, deleted→`삭제` |

`report.ts`:

| Old | New |
|---|---|
| `CONFIRMED_LABEL = "검증됨 (규칙 팩 기준)"` | `"규칙 팩 기준 판단 (사람 검토 전)"`; the finding is a model judgment, not a verified fact |
| `critical: "치명 (Critical)"` | `"심각 (Critical)"` (optional) |

Proposed `elementKo` for rules that fired: R-S01-001 `표준 명칭 '개인정보 처리방침' 표시`; R-S01-006 `항목별 구분과 알기 쉬운 표현`; R-S02-002 `처리 목적의 구체적 기재`; R-S03-002 `처리 항목의 구체적 기재`; R-S05-001 `근거별 보유기간`; R-S05-005 `업무별 구체적 보유기간`; R-S06-001 `지체 없는 파기`; R-S06-003 `파기 절차 및 방법`; R-S07-003 `제공받는 자의 개별 기재`; R-S16-001 `정보주체 권리와 행사 방법`; R-S18-001 `개인정보 보호책임자(또는 담당 부서)와 연락처`; R-S18-006 `개인정보 보호책임자의 업무(개정 제31조제4항)`. Add `elementKo` to every rule in the pack (content task for this role after approval).

Model fixHints: several state conditional rights as mandatory ("전송요구권을 추가해야 합니다") and one says methods are missing when a channel exists (캐슬). Prompt guidance: hints for factDependent elements must start with "해당되는 경우" and must not assert a duty.

## 6. Monitor golden labels

| File | Error | Fix |
|---|---|---|
| `policies/clean/expected.json` (+ derived seeds) | "Clean" forbids High, but under the current pack it fails R-S06-003 (no selection/approval step) and R-S16-001 (no 전송/자동화; also no 동의 철회, a core right under PIPA 37(1)). | Add to the clean fixture: a procedure sentence ("파기 사유가 발생한 개인정보를 선정하고 개인정보 보호책임자의 승인을 받아 파기합니다.") and "동의 철회" in S16. Re-derive seeds. |
| `policies/seed-s18-no-contact/expected.json` | `severityFloor: "low"` with anyOf S18-001/002/003. Removing all contacts breaks PIPA 30(1)6 ("전화번호 등 연락처"). | `ruleId: R-S18-001`, `severityFloor: "high"`. |
| `expected/pipa-21445.json` | S09 (26(4) "유출등", 26(8) adds 30-3 to the 준용 list), S11 (29 "유출등"), S13 (28-4(1) "유출등"), S19 (31-2 cross-references) are terminology or renumbering only. Listing them in `mustRuleSections` reads as must-change. | Add `changeClass: "terminology"` to those four; only S18 is substantive (31(3) board/report, 31(4) duties). Define or rename `mustRuleSections`. |
| same | S18 `rules` includes R-S18-001 only because of the broad `PIPA:31` ref. | After the §4 #3 fix, expect R-S18-005, R-S18-006 (and R-S18-001 for 31(1) wording only). |
| `real/lotte-2026-10-02.json` | Spot-check of all 10: mappings look right (combined headings carry `alsoAccept`). | None. |
| others (html, missing, unlabelled, vague, seed-s09-etc, neta-21988) | No error found. | — |

## 7. Heading patterns (fixed, 1.1.0 → 1.2.0)

Edited `kb/jurisdictions/kr/segmentation/heading-patterns.json` (changelog inside). `bun test`: 1006 pass, 0 fail.

| Change | Why |
|---|---|
| S12: removed exact "민감정보의 처리" and keyword "민감정보"; added keyword "공개 가능성" | S12 is only the disclosure-possibility notice (PIPA 30(1)3의3, 23(3)). A "민감정보의 처리" heading is items content. |
| S03: exact "민감정보의 처리", "고유식별정보의 처리" | Sensitive and unique-ID items belong to S03 (R-S03-007). |
| S13: exact "가명정보의 안전성 확보조치" | The S11 keyword "안전성 확보" won the tie; R-S13-006 is S13. |
| X1: keywords "개인위치정보", "위치정보 관리책임자" | A location-information officer heading went to S18 via "관리책임자". |

Not changed, noted: S17 keyword "프로파일링" (ad profiling is usually S15, not an automated decision); S08 keyword "판단 기준" is generic.

## 8. Needs a human expert

1. Approve the 2a policy (guideline-only `must` → Medium) and the R-S06-003 split.
2. Approve the 2b split; confirm per affiliate whether any is a public system operator or a health/telecom/energy transmitter today, and which will meet Decree 42-2(1)1 on 2027-02-20.
3. Whether each affiliate makes fully automated decisions (PIPA 37-2); decides the 7 uncertain R-S16-001 items.
4. Whether "목적 달성 시" and catch-all "등/기타" item lists breach PIPA 30(1)2 / Decree 31(1)1 (High) or only the guideline (Medium).
5. Whether omitting "지체 없이" (R-S06-001, 웰푸드) deserves High.
6. 하이마트몰 title: check the rendered page.
7. Guideline text (kb/_sources) to confirm the R-S06-003 and R-S16-001 source spans; STDG 18(1)/20(1) article text; safety-measures notice 파기 provisions. All ⚠️ Unverified here.
8. All 42 labels: this file is an AI self-review and the eval gate should treat it as provisional until a person confirms.

## 9. Applied by PM (2026-10-02, same day)

The user asked to apply the review at once. Applied, with tests (1008 pass, eval gates 25/25):

| Item | Change |
|---|---|
| 2a cap | `must` rules whose refs are empty or guideline-only (STDG, PIPCGL) cap at Medium in Mode A, with the note "(작성지침 권고 사항이며 법 조문 위반으로 단정하지 않습니다.)" (`hasStatutoryRef`, `current-check.ts`) |
| 2a refs | Verified refs added (decree and PIPA text checked again by PM): R-S02-002 `PIPA:3(1)`, `PIPA:30(1)1`; R-S03-002 `DEC:31(1)1`; R-S04-003 `PIPA:22-2(3)`; R-S05-005 `PIPA:30(1)2`; R-S05-003 `PIPA:30(1)3-2`; R-S14-002 `PIPA:30(1)7`; R-S16-002 `PIPA:38(4)`, `DEC:41(2)3` |
| 2a split | R-S06-003 (procedure and method, `PIPA:30(1)3-2`, `PIPA:21(2)`, `DEC:16(1)`) + new R-S06-005 (`should`: who selects and approves) |
| 2b split | R-S16-001 core rights (+`PIPA:35(1)`, `36(1)`, `37(1)`, `38(4)`); R-S16-005 refs and effectiveNote (2027-02-20); new R-S16-008 (`should`, factDependent) |
| §3 classes | R-S05-003, R-S16-002, R-S18-006 → textOnly; R-S12-001 → factDependent; R-S06-005 textOnly; R-S16-008 factDependent. R-S06-002 deferred (needs S05 text in the judge) |
| §4 map | R-S18-001 `PIPA:31` → `PIPA:31(1)`; DEC scheduled entry `DEC:42-2(1)1` 2027-02-20 → R-S16-005. PIPA 31(5)-(10) now map to no rule (officer status, not policy wording) |
| §5 wording | `elementKo` on 15 rules (section title is the fallback); new Mode A messages; vague-recipient text; Mode B "개정 범위: 제31조 제1항, 제3항~제4항" per article; 개정/신설/삭제; `CONFIRMED_LABEL` = "규칙 팩 기준 판단 (사람 검토 전)"; check prompt 1.2.0: conditional fix hints start with "해당되는 경우" |
| §6 labels | Clean fixtures add "동의 철회"; seed-s18-no-contact → R-S18-001 at High; pipa-21445 relabelled with `changeClass` (terminology vs substantive), unmapped 73; D5 source `PIPA:31(1)` |
| R-S01-001 | check regex accepts "개인정보처리방침" without spaces |

Deferred: R-S06-002 reclass; alias context-only rule (§4 #2); PIPCGL/NETA mode naming (§4 #4-5); STDG article text; `elementKo` for the remaining rules; R-S16-002 statement wording; "치명 → 심각" (optional). Human items in §8 stay open.

## 10. Re-run verification (2026-10-03)

> **AI 자체 검토 — 사람 전문가 검증 전.** Same role and rules as above. Not legal advice.

Runs: `runs/lotte-real/llm-v5/2026-10-02T23-26-36-722Z` (9 policies) and `runs/lotte-real/llm-v6-rental/2026-10-02T23-49-08-991Z` (롯데렌탈).
Labels: `golden/monitor/real-run-labels-2026-10-03.json` (51 findings: 29 High, 7 Medium incl. 1 Mode B, 15 Low; ids and reasons only).

### 10.1 Numbers

| Set | TP | FP | unc. | Precision | Earlier (2026-10-02) |
|---|---|---|---|---|---|
| High | 22 | 7 | 0 | **75.9%** | 83.9% (26/31), 39 High |
| Medium | 6 | 0 | 1 | 100% | — |
| High + Medium | 28 | 7 | 1 | **80.0%** | 85.3% (29/34) |
| Low | 11 | 4 | 0 | 73.3% | not labelled |
| TP with wrong severity (High/Medium) | 8 | | | | 12 |
| High TP with the right severity | 15 | | | | 14 |

Read this with care. Precision fell because the easy TPs left: the 10 R-S06-003 findings are now Low (R-S06-005), and 7 uncertain R-S16-001 findings are gone. The FP count rose from 5 to 7 on 10 fewer High findings. Uncertain fell from 8 to 1. The alert set is smaller and better-graded, but the FP pool did not shrink.

### 10.2 FPs: gone, kept, new

| | Finding | Why |
|---|---|---|
| Gone | 웰푸드 R-S16-001 | 2b split: 전송요구권 is now R-S16-005 (Confirm). |
| Kept | L.POINT R-S05-001 | A./B. sub-lines still split from their numbered item. |
| Kept | 건설 R-S02-002 | Summary label with a "see body" pointer still judged as purposes. |
| Kept | 캐슬 R-S05-005 | Event-based end point still read as "no period". |
| Kept | 캐슬 R-S16-001 | General channel for all rights; model wants per-right menus. |
| New | 백화점 R-S06-001 | "Without delay" is in paragraph 1; the model attached the vague "stored for a period under internal policy" wording to this rule. That gap belongs to R-S06-002 / R-S05-003. |
| New | 하이마트 R-S05-001 | Periods sit in the items table's retention column; the S05 judge does not see it (fix 569ac44 covers headings only, not this rule). |
| New | 이노베이트 R-S05-003 | Statute, article and period present; only numbering style is off. The fix hint asserts article numbers that are in neither the page nor the rule pack. |

Low FPs: 글로벌로지스 and 하이마트몰 R-S01-005 (a linked table of contents exists: anchors or script links), 렌탈 R-S01-003 (preamble exists after site menu), L.POINT R-S01-003 (defined term "회사" is fine).

### 10.3 Severity corrections (TP)

R-S16-001 at 백화점, 하이마트, 하이마트몰: consent withdrawal is reachable through membership withdrawal but not named as a right → Medium. 웰푸드 R-S06-001 → Medium. L.POINT R-S05-003 (law named, article missing) → Medium. 렌탈 R-S16-002 (same gap as R-S16-001, double-counted) → Medium. 하이마트몰 R-S05-003 (heading names a record type with no row) → Low. L.POINT Mode B S18 (content is R-S18-006, should; duplicates Mode A A-0011) → Low.

### 10.4 Confirm spot-check (15 items)

| # | Item | Verdict |
|---|---|---|
| 1 | 캐슬 B-0012 S13 "가명정보 항목을 찾지 못함" (28-4(1) "유출등") | useless: terminology-only change |
| 2 | 캐슬 B-0016 S19 국내대리인 (31-2 cross-ref) | useless: renumbering; domestic company |
| 3 | 백화점 B-0013 S09 (26(4), 26(8)) | useless: terminology / 준용 list |
| 4 | L.POINT B-0021 S11 (29 "유출등") | useless: terminology |
| 5 | 캐슬 A-0009 R-S03-002 "해당 사실이 있는지 확인하십시오" | useless: placeholder question on a textOnly rule |
| 6 | 글로벌로지스 A-0009 R-S16-001 "이 항목에서는 확인되지 않지만…" | misleading: core rights are in the section (table rows) |
| 7 | 웰푸드 A-0008 R-S16-001 same wording | misleading: rights sentence is in S16 |
| 8 | 하이마트몰 A-0012 R-S16-002 "웹사이트를 운영합니까?" | useless: the page was fetched from the website |
| 9 | 캐슬 A-0013 R-S16-005 정보전송자 여부 | sensible |
| 10 | 백화점 A-0010 R-S03-001 계좌번호 실제 수집 여부 | sensible |
| 11 | L.POINT A-0025 R-S24-001 (last version 2018) | sensible, useful |
| 12 | 캐슬 A-0017 C2-M-S24 not located | sensible |
| 13 | 글로벌로지스 A-0005 R-S05-005 제보 정보 보관기간 | sensible |
| 14 | 렌탈 A-0017 R-S11-002 "기재되지 않은 조치를…" | sensible but leading (hints at a gap) |
| 15 | 백화점 B-0018 S18 제31조 영향 | sensible |

8 of 15 are useless or misleading. Across the whole run, 21 Mode B Confirms come from terminology or renumbering units (S13 ×9, S19 ×9, S09 ×2, S11 ×1).

### 10.5 Systematic issues and fixes

| # | Pattern (policies) | Fix |
|---|---|---|
| 1 | Mode B asks about absent S13/S19/S09/S11 for terminology-only units (all 10) | Code (`article-diff.ts` / `impact.ts`): classify a unit `terminology` when old and new texts are equal after normalizing the defined-term swap ("분실ㆍ도난ㆍ유출ㆍ위조ㆍ변조 또는 훼손" → "유출등") and cross-reference renumbering; list such units once per run, never per policy. Do not ask "section not found" for a conditional section (S13, S19) at all. |
| 2 | Mode B primary rule picks R-S18-001 because 31(1) (wording only) maps there (5 policies; L.POINT Medium) | Code: choose the primary rule from substantive units only (after #1); 31(1) becomes terminology, so S18 maps to R-S18-005/006 (should). Drop a Mode B finding that duplicates a Mode A finding on the same rule. |
| 3 | Retention judged without the retention column or with split sub-lines (L.POINT, 하이마트: 2 FPs, 2 runs) | Code: for S05 rules give the judge the S02/S03 table rows that carry a retention column (`PURPOSE_TABLE_SECTIONS`), and join `A.`/`B.` sub-lines to the numbered parent in the segmenter. Prompt: "a record counts as stated if any line under the same item gives its type, basis or period." |
| 4 | "Without delay" rule used for vague "internal policy, a period" storage (백화점) | Prompt: R-S06-001 is met if the section says 지체 없이 anywhere. Rule: apply the deferred R-S06-002 reclass (judge sees S05) so that wording has the right home. |
| 5 | Consent withdrawal only via 탈퇴 reported High (백화점, 하이마트, 하이마트몰) | Rule: R-S16-001 statement: "a stated membership-withdrawal path counts as a withdrawal procedure". New `should` R-S16-009 "name consent withdrawal as a right" (PIPA 37(1)) → Low. Keep High when there is no withdrawal path (이노베이트, 렌탈). |
| 6 | Fix hints cite article numbers not in the page or the rule pack (이노베이트) | Prompt: "never cite an article number unless it is in the rule's legalRefs or the quoted text". Code: flag `제\d+조` in fixHint not found in either; replace with the rule statement. |
| 7 | Misplaced-missing Confirms on rights present (글로벌로지스, 웰푸드) and placeholder questions on textOnly rules (캐슬) | Code: a textOnly rule with model verdict `confirm` is re-judged or dropped, never emitted with the generic question; skip the misplaced path when the section text itself contains the element keywords (열람, 정정, 삭제, 처리정지). Include table rows in S16 model text. |
| 8 | R-S16-002 asked "do you run a website?" (하이마트, 하이마트몰) | Code: add "published on the operator's website (fetched URL)" to the user turn for web-fetched policies. |
| 9 | Table of contents links invisible to the judge (글로벌로지스, 하이마트몰) | Code: ingest records `doc.toc.linked` from `href="#…"` or `javascript:` links; make R-S01-005 deterministic. |
| 10 | Recall gap: R-S06-005 fired on 5 of 10 although no policy names an approver | Low priority (should rule). Make R-S06-005 deterministic on approval keywords (승인, 결재) in S06. |

Note for InfoSec: the 롯데렌탈 page states it took effect 2020-12-03, and the version list in L.POINT's static page ends in 2018 (the list may be stale; check the live page). Text that old predates the 2026.4 guideline, which explains many of their findings.

### 10.6 Still for a human

Items in §8 remain open. Add: whether withdrawal-through-탈퇴 should be Medium or Low (10.5 #5); whether article numbers in statutory retention rows deserve High (렌탈, L.POINT).

## 11. Applied by PM (2026-10-03)

§10.5 #1-8 applied (`51f7a07`, `5270528`); #9 (linked table of contents) and #10 (deterministic R-S06-005) deferred, and the
R-S06-002 reclass stays deferred. After the v7 re-run, R-S16-002 went back to factDependent: with the website hint it fired
High on 5 policies whose pages publish the request method; 38(4) needs collection through the website, a fact the text
cannot show. Results: `docs/reports/2026-10-02-lotte-real-run.md` (v7 section).
