# Real-policy run: 10 published Lotte privacy policies (2026-10-02)

> 참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다.

First run of the Policy Monitor on real pages rather than synthetic fixtures. Policies were fetched with the Peer Watch fetcher
(`agent.ts peers --dry-run --with-lotte --save-lotte watch/lotte`: robots.txt, one page per host per day, honest user agent).
Raw pages stay in the gitignored `watch/`; reports stay in the gitignored `runs/lotte-real/`. No quote below contains contact data.

## Coverage

| | Count | Notes |
|---|---|---|
| Lotte captures in the registry | 26 | holdings excluded (user decision) |
| Fetched | 10 | 웰푸드, 백화점, 하이마트, 하이마트몰, 건설, 캐슬, 렌탈, 글로벌로지스, 이노베이트, L.POINT |
| robots.txt unreachable | 7 | 칠성, 마트 (+CCTV), 세븐일레븐 (+CCTV), 호텔 (+CCTV), 채용 |
| Same host, daily limit | 5 | CCTV policies; fetchable on later days |
| Other | 3 | 시네마 (page over 5 MB cap), 멤버스 (JS-only page, manual review), 월드 (modal, no direct URL) |

## Defects the real pages exposed (all fixed, with tests)

| # | Symptom | Cause | Fix (commit) |
|---|---|---|---|
| 1 | High "S05 heading without content" on 백화점, 글로벌로지스 | Summary labels / table of contents; the text sat under a combined heading | Empty heading whose topic appears elsewhere is Confirm (`ba54f4f`) |
| 2 | 민원서비스, 고지의 의무, 동의철회 headings unmapped | Pattern gaps | heading-patterns 1.1.0 (`4a8ba12`) |
| 3 | Critical "officer missing" on 백화점 | `<h3>[제 9-11 조]` compared with a plain `2.` line on a different depth scale and folded under the cookie section | Heading elements never fold under plain lines (`ff1ec8a`) |
| 4 | Critical "missing" on a prohibition (`no abbreviation`) | Model verdict misuse | A prohibition cannot be "missing" (`ff1ec8a`) |
| 5 | "열람 권리 없음", "표준 제목 없음" | The model saw body paragraphs only; rights were sub-headings, the title a heading | Model text includes the policy's own headings (`218939a`) |
| 6 | Finance paragraphs in Mode B prompts | Only Mode A filtered them | Shared `sectionModelText` (`218939a`) |
| 7 | Critical "retention missing" on 하이마트 | Retention per purpose was a column of the items table | Retention column in an S02/S03 table counts as content elsewhere (`569ac44`) |
| 8 | `&middot;` left in text and quotes | HTML named entities not decoded | `decodeNamedHtmlEntities` (`569ac44`) |

Effect on Critical findings: first model run (old code, 6 policies) 5 Critical; final run 0 Critical on 10 policies.

## Final result (model run: 106 + 12 calls, list-price estimate $5.48, Claude Code subscription)

Mode A (current check) across the 10 policies: Critical 0, High 39, Medium 2, Low 7, Confirm 89.
Mode B (개인정보 보호법 제21445호 impact): 29 provisional Confirm, 1 provisional Medium (L.POINT S18, officer wording vs. PIPA 31).

High findings by rule:

| Rule | Policies | Pattern | Assessment |
|---|---|---|---|
| R-S06-003 destruction procedure detail | 10/10 | Old template "목적 달성 후 별도 DB로 옮겨져 … 파기" without who selects and approves | Group-wide template gap. The rule has no legal reference (guideline only) but is `must`: domain expert to decide whether guideline-only rules cap at Medium |
| R-S16-001 rights and how to exercise | 10/10 | 열람·정정·삭제·처리정지 listed; 전송요구권 and 자동화된 결정 거부·설명요구 absent | Group-wide gap against the 2026.04 guideline. 전송요구권 applies only to designated processors, so the expert should consider a fact-dependent split |
| R-S02-002 specific purposes | 5 | Open lists ending in "등" | Plausible |
| R-S03-002 no abbreviation | 5 | "거래정보", "포인트정보", "기타 서비스 이용 기록" | Plausible |
| R-S05-005 period per purpose | 4 | "목적이 달성된 때", "동의를 득한 기간까지" | Plausible |
| others | 5 | R-S01-006 (2), R-S07-003 (2), R-S01-001, R-S06-001, R-S05-001 | Spot-check needed; R-S01-001 on 하이마트몰 may be a title-detection miss |

Not yet verified by a person: every finding above is a reference for 정보보호실 review, and no label set exists for real policies yet
(the eval gate "real-policy segmentation" stays skipped until a person labels these 10 pages).

## Worklist for 정보보호실

`runs/lotte-real/롯데_처리방침_점검_작업목록_2026-10-02.xlsx` (gitignored, built from the run JSON): 안내, 요약 (COUNTIFS over the list,
review progress), 공통 패턴 (the two 10/10 patterns with each affiliate's wording), 지적 목록 (167 rows with review columns:
수정 필요 / 해당 없음 / 오탐 / 보류). Formulas recalculate on open; LibreOffice could not run in the cloud container.

## Follow-ups

1. Domain expert: severity of guideline-only `must` rules (R-S06-003); fact-dependent split of R-S16-001 (전송요구권).
2. Segmentation noise: table-of-contents duplicates and site chrome (렌탈: 64 UNMAPPED blocks) are not judged but cost prompt
   tokens only when mapped; a TOC filter would shorten S01.
3. Fetch the remaining 16 (robots unreachable may be transient; CCTV pages on later days; 시네마 needs a higher size cap
   for that host; 멤버스 and 월드 need manual capture).
4. Done: `golden/monitor/real/lotte-2026-10-02.json` labels 132 article headings (AI self-labelled, human review pending); gate M8.seg.real = 0.985 when the pages are present. This is a development slice (fixes were made on these pages); label the next 16 pages as the held-out slice.
5. 18 PIPA amendment units map to no rule (Art. 34 breach notification, 30-3, 39) — expected for a privacy-policy rule pack, listed for review.

## Re-run after the domain self-review (2026-10-02, late)

Same 10 pages, rules and code after `dd9f537` and `c390cf9` (guideline-only cap, R-S06-003/R-S16-001 splits, adaptive
numbering, element-missing = High). 109 + 8 model calls, list-price estimate $5.44.

| | Critical | High | Medium | Low | Confirm |
|---|---|---|---|---|---|
| Before (v3/v4) | 0 | 39 | 2 | 7 | 89 |
| After (v5/v6) | 0 | 29 | 7 | 15 | 110 (Mode A 81 + Mode B 29) |

- Destruction approval step (now R-S06-005, should): Low on 5 policies instead of High on 10.
- Rights (R-S16-001, core rights only): High on 6. Transmission and automated decisions are now conditional questions.
- 롯데렌탈 R-S16-001 first came out Critical ('missing' on a partial list); fixed in `c390cf9` and re-run: High with the incomplete list quoted.
- Not yet re-labelled: the 42-finding labels apply to the v3 run; precision of this run needs a new pass.
