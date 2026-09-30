> Date: 2026-09-29. Author role: automation-engineer (research spike, Row 3).
> Scope: law.go.kr Open API and PIPC/KFTC source verification for the Korea KB.
> Note: OC=test was the sample key used in this spike and is NOT approved for production use.

# Row 3 Research Spike: Korean law sources for the privacy-policy / ToS drafting agent

Fetched: 2026-09-29 (all "fetched" dates below). Read-only. No file inside C:\aiagent was edited.
Convention: VERIFIED = confirmed on an official domain from your list (law.go.kr, open.law.go.kr, pipc.go.kr, privacy.go.kr, ftc.go.kr).
UNVERIFIED = not confirmed on such a domain. Raw evidence files (XML/HTML) sit next to this report in the spike folder.

## 0. Method note (important for PM)
- Every law fact below was read from the official law.go.kr DRF API, not from news pages.
- I used the public sample key `OC=test` (the value printed in every official guide sample URL) for read-only queries.
  It returns full data. Whether it is allowed for production use is UNVERIFIED; plan on a registered OC (section 1.5).
- "kftc.go.kr" in the brief does not resolve here (DNS error). The Korea Fair Trade Commission site is `ftc.go.kr`. I used that.

## 1. law.go.kr Open API (open.law.go.kr guide, fetched 2026-09-29)
Guide index: https://open.law.go.kr/LSO/openApi/guideList.do (191 API entries). Each guide page is a POST:
`POST https://open.law.go.kr/LSO/openApi/guideResult.do` with form field `htmlName=<id>` (ids: lsNwListGuide, lsNwInfoGuide, lsEfYdListGuide, lsEfYdInfoGuide, lsHstListGuide, lsChgListGuide, lsJoChgListGuide, lsNwJoListGuide, admrulListGuide, admrulInfoGuide ...).
Docs print `http://www.law.go.kr/DRF/...`; `https://law.go.kr/DRF/...` and `https://www.law.go.kr/DRF/...` both answered 200.

### 1.1 Common parameters
- `OC` (required, issued key), `target` (required), `type` = `XML` | `JSON` | `HTML` (XML is default; some history APIs are HTML only, see below).
- List APIs: `query`, `display` (default 20, max 100), `page`, `sort` (`ddes` = promulgation date desc, `efdes` = effective date desc), `nw`, `LID`, `efYd`, `ancYd`, `org`, `knd`.

### 1.2 (a) Search a law by name - `target=law` (current law, by promulgation date)
`https://law.go.kr/DRF/lawSearch.do?OC={OC}&target=law&type=XML&query={UTF-8 percent-encoded name}`
Returns `<law>` rows: 법령일련번호 (= MST), 현행연혁코드, 법령명한글, 법령약칭명, 법령ID, 공포일자, 공포번호, 제개정구분명, 소관부처, 법령구분명, 시행일자, 법령상세링크.
Tested: `query=개인정보 보호법` returned the Act (ID 011357, MST 283839) plus the decree (ID 011468) because search is a substring match; filter on exact 법령명한글.
Effective-date variant: `target=eflaw` (adds `nw=1,2,3` = 연혁/시행예정/현행, `LID=<법령ID>`, `efYd`).

### 1.3 (b) Law body - `target=law` / `eflaw`
`https://law.go.kr/DRF/lawService.do?OC={OC}&target=law&MST={법령일련번호}&type=XML` (or `ID={법령ID}`; ID returns the current text).
`target=eflaw` needs `efYd={YYYYMMDD}` when MST is used.
The XML contains 조문단위 (articles), 부칙 (with 부칙공포번호), 별표, 개정문, and 제개정이유. I used 부칙 and 제개정이유 to fix effective dates.
JSON works the same way with `type=JSON`. HTML is the rendered page.

### 1.4 (c) Article level and (d) history
- Single article: `lawService.do?OC=..&target=law&MST=..&JO=003700&type=XML` where JO = 4-digit article + 2-digit branch (제37조의2 = `003702`). Doc: guide id `lsNwInfoGuide`.
- 조항호목 (article/paragraph/item/sub-item): `lawService.do?OC=..&target=lawjosub&ID=..&JO=..&HANG=..&HO=..&MOK=<percent-encoded 가나다>&type=XML`. Doc: `lsNwJoListGuide`.
- Amendment history of one law (used for section 3): `lawSearch.do?OC=..&target=eflaw&type=XML&LID={법령ID}&nw=1,2,3&display=100&sort=efdes`. This lists every version incl. 시행예정 (scheduled) with 공포번호, 공포일자, 시행일자. Doc: `lsEfYdListGuide`.
- Other history APIs: `target=lsHistory` (list `lawSearch.do`, body `lawService.do`; type HTML only), `target=lsHstInf&regDt=YYYYMMDD` (laws changed on a date; HTML/XML/JSON), `target=lsJoHstInf` (article-level revision list; `fromRegDt`/`toRegDt`, or `lawService.do?target=lsJoHstInf&ID=..&JO=..`; XML/JSON).
- Change-detection idea: call `lsHstInf&regDt=<today>` or `eflaw&LID=..&nw=2,3` on a schedule; a new MST/공포번호 = new edition.

### 1.5 OC key registration (open.law.go.kr)
- VERIFIED: sign-up at https://open.law.go.kr/LSO/usrJoin.do collects e-mail (=user ID), name, password, phone, organization name. Then apply for the API ("OPEN API 신청", /LSO/openApi/cuAskList.do, login required, 302 without login) and wait for approval.
- VERIFIED: "승인 처리는 신청후 1~2일 이내" and "모든 DATA 활용은 공동활용이용 승인 후 가능" (https://open.law.go.kr/LSO/information/guide.do).
- VERIFIED: calls with an unregistered OC return HTTP 200 with a body: `사용자 정보 검증에 실패하였습니다.` / `OPEN API 호출 시 사용자 검증을 위하여 정확한 서버장비의 IP주소 및 도메인주소를 등록해 주세요.` So the approved server IP and domain are part of registration. A script must check the body, not the HTTP status.
- VERIFIED: usage may be restricted for traffic overload or commercial use of APIs that forbid it; no numeric rate limit is published (guide.do). Law data is free for commercial use but source attribution is mandatory and forging/altering is criminal (same page).
- UNVERIFIED (needs login): exact form fields for IP/domain, whether the OC string equals the e-mail ID, per-key quotas. The "API인증키관리" (/LSO/usr/usrOcInfoMod.do) and "IP 접속이력" pages are behind login.
- Contacts on official page: registration/quota 044-200-6797, technical 02-2109-6446.

### 1.6 Target laws: API-reachable vs web-only (details in law-targets.json)
| Item | Via API | ID / MST (as of 2026-09-29) | Effective |
|---|---|---|---|
| 개인정보 보호법 | `law`/`eflaw` | ID 011357, MST 283839 | 2026-09-11 (+2027-03-09, 2027-07-01 scheduled) |
| 개인정보 보호법 시행령 | same | ID 011468, MST 289537 | 2026-09-11 |
| 약관의 규제에 관한 법률 | same | ID 000667, MST 260021 | 2024-08-07 |
| 전자상거래 등에서의 소비자보호에 관한 법률 | same | ID 009318, MST 282793 | 2026-07-21 (next 2027-01-21) |
| 정보통신망 이용촉진 및 정보보호 등에 관한 법률 | same | ID 000030, MST 283843 | 2026-09-11 (more scheduled, see 3.3) |
| 신용정보의 이용 및 보호에 관한 법률 (scope note) | same | ID 001540, MST 283841 | 2026-09-11 |
| 표준 개인정보 보호지침 (고시 제2025-4호) | `target=admrul` | admrul ID 2100000257592 | 발령 2025-04-11 |
| 개인정보의 안전성 확보조치 기준 (고시 제2026-9호) | `target=admrul` | admrul ID 2100000281400 | 시행 2026-07-01 |
| 개인정보 처리방침 작성지침 | NOT in API (admrul search returns 0) | web only | see section 4 |
Admin-rule API: `lawSearch.do?OC=..&target=admrul&type=XML&query=..` (params nw, knd 3=고시, prmlYd) and `lawService.do?target=admrul&ID=<행정규칙일련번호>`. Doc ids: admrulListGuide, admrulInfoGuide.
Web pages exist as `https://www.law.go.kr/법령/<name without spaces>` and `/행정규칙/<name>`; they are thin iframe shells (content at `/LSW/lsInfoP.do` / `/LSW/admRulInfoP.do`), so use the API for content.

## 2. Verification of the four third-party claims
| # | Claim | Verdict | Key evidence |
|---|---|---|---|
| 2a | 2026 PIPA amendment, effective 2026-09-11, turnover surcharge up to 10% | VERIFIED (with qualifiers) | Law No. 21445, promulgated 2026-03-10, effective 6 months later = 2026-09-11 (two provisions 2027-07-01). Art. 64-2(2) new: up to 10% of total turnover only for (1) intentional/grossly negligent repeat within 3 years, (2) intentional/gross-negligence breach harming 10M+ people, (3) non-compliance with a corrective order that leads to a leak. Baseline cap in 64-2(1) stays 3% (text read from API). |
| 2b | KFTC standard terms 제10023호 | VERIFIED: it is "전자상거래 표준약관" | Board row nttSn=11139: "[제10023호] 전자상거래 표준약관", dept 약관심사과, registered 2014-09-23, attachment `2015_6._26._개정 (전자상거래 표준약관).hwp` (last revision 2015-06-26). |
| 2c | Data portability, Art. 35-2, effective 2025-03-13 | VERIFIED | Act 19234 부칙 1(2): 35-2 takes effect on a date set by decree; decree 35343 부칙 1(2) sets it to 2025-03-13; eflaw list shows a version row with 시행일자 20250313. Current title: "개인정보의 전송 요구". |
| 2d | Automated-decision objection, Art. 37-2, effective 2024-03-15 | VERIFIED | Act 19234 부칙 1(1): 37-2 effective 1 year after promulgation (2023-03-14) = 2024-03-15; eflaw row 20240315. Current title: "자동화된 결정에 대한 정보주체의 권리 등". |
Sources: see pending-verification.json. Amendment reasons quoted from the API's 제개정이유 field. News pages (lawtimes, seoul.co.kr) were NOT needed and are not relied on.

### 2b detail: KFTC standard terms relevant to online services (list read 2026-09-29, 99 rows)
Board: https://www.ftc.go.kr/www/selectBbsNttList.do?bordCd=201&key=202
| 호수 | Title | Latest date on board |
|---|---|---|
| 제10023호 | 전자상거래 표준약관 | 2015-06-26 revision (registered 2014-09-23), nttSn 11139 |
| 제10069호 | 온라인게임 표준약관 | 2024-02-23 revised |
| 제10078호 | 모바일게임 표준약관 | 2024-02-23 revised |
| 제10074/10075/10076호 | 해외구매 (배송대행 / 위임형 / 쇼핑몰형) 표준약관 | registered 2016-10-25 |
| 제10028호 | 전자금융거래기본약관 | registered 2017-01-25 |
| 제10054호 | 전자보험거래 표준약관 | registered 2007-06-01 |
| 제10073호 | 신유형 상품권 표준약관 | revised 2025-09-11 |
No standalone "인터넷 사이트/웹사이트 이용약관" standard terms exists on this list (REFUTED as a distinct item). A search snippet called an "인터넷 사이버몰 이용표준약관 (제10023호)" first enacted 2010-12-17; the cited old ftc.go.kr URL now redirects to the homepage, so that history is UNVERIFIED. Newest rows overall: 제10029호 장례식장 (2026-08-20), 제10083호 요가·필라테스 (2026-07-16 제정).

## 3. PIPA and decree amendments with effective date in 2025-01-01 .. 2027-12-31
Source: eflaw history (LID 011357 / 011468, nw=1,2,3) + 부칙 + 제개정이유 read from API on 2026-09-29. All rows VERIFIED unless marked.

### 3.1 개인정보 보호법 (Act)
| Promulgation no. (date) | Effective | Change relevant to privacy policies |
|---|---|---|
| 제19234호 (2023-03-14) | 2025-03-13 (35-2 stage) | Right to request transmission of personal data (35-2, 35-3, 35-4); decree fixed the date. Earlier stages 2023-09-15 and 2024-03-15 are outside the window. |
| 제20897호 (2025-04-01) | 2025-10-02 | Domestic representative (31-2): must be chosen from certain domestic affiliates; name/address/phone/e-mail of the representative must be in the 처리방침 (fine up to 10M won if omitted). |
| 제21445호 (2026-03-10) | 2026-09-11; 2027-07-01 for 32-2(1) proviso and 75(2)15 | New 30-3 (owner/CEO ultimate responsibility); 31 CPO strengthened, board resolution and report to PIPC for large processors; leak notification extended (34: forged/altered/damaged data, and "possibility of leak" notice); 10% surcharge (64-2(2)); mandatory privacy certification for large processors from 2027-07-01. Its 부칙 also fixes cross-references in 신용정보법 Art. 20 and 정보통신망법 Art. 45-3. |
| 제21910호 (2026-09-08) | 2027-03-09 | AI development section (28-12 to 28-15): reuse of lawfully collected data for AI development after PIPC deliberation; 28-12(5): purpose and type of such use must be stated in the 처리방침; prior risk assessment duty. |

### 3.2 개인정보 보호법 시행령 (Decree)
| Promulgation no. (date) | Effective | Change |
|---|---|---|
| 제35343호 (2025-02-25) | 2025-02-25 / 2025-03-13 / 2025-07-01 / 2026-06-01 | Portability implementation (Arts. 42-2 to 42-16), specialised bodies; 2026-06-01 stage for 42-2 item 3 and 42-4(1) item 3; 결합전문기관 criteria 2025-07-01. |
| 제35780호 (2025-09-23) | 2025-10-02 | Domestic-representative criteria, fines; local-government-funded institutions become public institutions. |
| 제35811호 (2025-10-01) | 2025-10-01 | Government-reorganisation batch amendment (ministry names). |
| 제36340호 (2026-05-19) | 2026-05-19 | Surcharge revenue base: the higher of prior-year revenue vs 3-year average; mitigation may be denied for very serious violations. |
| 제36121호 (2026-02-19) | 2026-08-20; item 42-2(1)1 one year after promulgation (derived 2027-02-20, UNVERIFIED: no separate row in eflaw list) | Portability to the data subject widened to all data about the person; thresholds for who must comply (avg revenue > 180 bn won plus size tests, or 1M+ persons, public-system operators). |
| 제36671호 (2026-09-10) | 2026-09-11 | CPO designation report (Art. 32(4)), "leak possibility" notice within 72 hours (new 39-2, 39-3), surcharge reduction for prevention investment (up to 40%). |
Listing note: the eflaw list also shows Act 19234 amendments 2023-09-15 and 2024-03-15 and decree 34309/33723 stages in 2024; all before the window.

### 3.3 Related laws with scheduled changes (for scope only; effective dates from eflaw rows)
- 정보통신망법: MST 285199 (No. 21500, promulgated 2026-03-31) effective 2026-10-01 and 2027-04-01; MST 290001 (No. 21988, promulgated 2026-09-29) effective 2026-10-02; decree MST 290483 (No. 36728) effective 2026-10-02. Content not read.
- 전자상거래법 (No. 21312) and decree (No. 36507): effective 2027-01-21 (current version effective 2026-07-21). Content not read.
- 약관법: no scheduled change; current version effective 2024-08-07.

## 4. PIPC 개인정보 처리방침 작성지침: publication pages and change detection
Current edition confirmed: title "개인정보 처리방침 작성지침(2026.4. 개정)". Neither board gives an edition number; the title text and dates are the signal.
| Site | Page | Fields (fetched 2026-09-29) |
|---|---|---|
| pipc.go.kr (안내서 board, dept 자율보호정책과) | list https://www.pipc.go.kr/np/cop/bbs/selectBoardList.do?bbsId=BS217&mCode=G010030000&schTypeCd=3 (www redirects 301 to pipc.go.kr) ; post `selectBoardArticle.do?bbsId=BS217&mCode=G010030000&nttId=12018` | Title `개인정보 처리방침 작성지침(2026.4. 개정)`, 작성일 2026-04-23, attachment `2026 개인정보 처리방침 작성지침.pdf` (11,451,612 bytes in an HTML comment), atchFileId FILE_000000000560753. Prefix tag `[현재 안내서]`. |
| privacy.go.kr (개인정보 포털) | list https://www.privacy.go.kr/front/bbs/bbsList.do?bbsNo=BBSMSTR_000000000049 ; post `bbsView.do?bbsNo=BBSMSTR_000000000049&bbscttNo=20885` | Title `2026 개인정보 처리방침 작성지침`, 등록일 2026-04-24, attachment `2026 개인정보 처리방침 작성지침.pdf` (atchFileId ATCH_000000000934742). Earlier edition: bbscttNo 20806 titled `개인정보 처리방침 작성지침(2025.4.)`. |
Related PIPC items found (same boards): `개인정보 처리방침 표준(안) (2026.2.)_파일수정게시('26.3.6.)` (privacy.go.kr 20869, 2026-02-27); `개인정보 유출등 대응 안내서(2026.9.)` (20918, 2026-09-14); `과징금 투자감경제도 안내서` (20919); `개인정보 보호책임자 지정·신고 실무 매뉴얼(2026.9.)` (pipc.go.kr, 2026-09-15). PIPC also pins a notice `개인정보위 안내서 전체 목록(260731 기준)` (dated 2026-08-03), a catalog whose title date changes on each refresh.
Notably no revision of the 작성지침 has been posted since the 2026-09-11 Act took effect (as of 2026-09-29).
Watcher recipe (plain HTTP GET, no JS needed on either board):
1. GET the pipc.go.kr list; regex each row for `처리방침 작성지침`; capture title, `nttId`, 작성일. Do the same on privacy.go.kr (`$bbs.view('<bbscttNo>'` in the onclick, date in the row).
2. New edition if: nttId greater than 12018 (pipc) or bbscttNo greater than 20885 (privacy) with a matching title, or the `(YYYY.M. 개정)` / `YYYY` token in the title exceeds 2026.4, or the same post shows a changed 작성일 / attachment byte size / fileSn count. Titles changed format between years ("(2025.4.)" vs "2026 ..." vs "(2026.4. 개정)"), so match on the substring, not an exact string.
3. Fallback signal: the pinned `개인정보위 안내서 전체 목록(YYMMDD 기준)` title date, and the 표준(안) post.
4. Optionally hash the PDF (download is a POST form on pipc.go.kr, GET `/cmm/fms/FileDown.do?atchFileId=ATCH_000000000934742&fileSn=1` on privacy.go.kr). I did not download it.
Content claims about the 2026.4 edition (generative-AI appendix, on-device two-type rule, categorised recipients) came from Asiae/Korea.kr press pages, not from the PDF: UNVERIFIED until the PDF you hold is read.

## 5. KFTC standard terms: pages and change detection
- Board list (current site layout): https://www.ftc.go.kr/www/selectBbsNttList.do?bordCd=201&key=202&pageIndex={1..10}. 10 rows per page, ~99 rows, sorted by registration date desc.
- Row: `[제NNNNN호]<title> (YYYY. M. D. 개정|제정)`, 담당부서, 등록일, view link `selectBbsNttView.do?key=202&bordCd=201&nttSn=<id>`, file link `downloadBbsFile.do?atchmnflNo=<id>` (e.g. 전자상거래 표준약관 atchmnflNo 14800).
- Baseline to store today: max nttSn 47926 (제10029호 장례식장, 2026-08-25); 제10023호 nttSn 11139 (attachment date 2015_6._26).
- Detection: (1) parse row count and max nttSn from page 1; (2) parse 호수 + date token per row and diff; (3) for tracked rows (10023, 10069, 10078, 10074-76) fetch the view page and diff the attachment name and atchmnflNo. Revisions sometimes add a NEW row (신유형 상품권 10073 appears 4 times: 2015, 2020, 2024, 2025) and sometimes update the old one, so track by 호수, not by nttSn.
- The 약관법 text itself and the legal basis are on law.go.kr (section 1.6). Standard terms are not exposed by the law.go.kr API.

## 6. Things that can break automated checking
1. Open API error is HTTP 200 with an error body (unregistered OC / unregistered IP or domain). Always parse `<Response><result>`. Since the server IP and domain are registered, CI runners with changing IPs will fail.
2. Windows shells: passing Korean characters as curl arguments from Git Bash was converted to CP949 and produced garbled queries (0 hits). Send UTF-8 percent-encoded queries (or use an HTTP library) and keep `chcp 65001` / UTF-8 as your CLAUDE.md already advises.
3. `OC=test` works for samples but is a shared sample key: may be throttled or changed; do not rely on it in production.
4. Guide docs print `http://` URLs and old `www` host; prefer `https://law.go.kr/DRF/...`. The guides carry a revision history (last edits 2025-07-24 and 2025-09-23), so parameter docs do change.
5. law.go.kr web pages (`/법령/<name>`) are iframe shells; content is not in the first response. Use the API or `/LSW/lsInfoP.do` targets.
6. pipc.go.kr: `www` host 301-redirects to the bare host (use redirect following). robots.txt only disallows Googlebot for `/../srch.do` and `/../bbs/`, no rule for other agents. File download is a POST form on pipc.go.kr.
7. privacy.go.kr: lists are server-rendered (850 KB per page), robots allows all except `/front/search/search.do`. View links are JS (`$bbs.view(id, url)`) but the plain GET `bbsView.do?...&bbscttNo=<id>` works.
8. ftc.go.kr: site was redesigned; old URLs (`selectBoardArticle.do?key=201&nttId=...&bbsId=BBSMSTR_000000002320`, `contents.do?key=340`) return the homepage with HTTP 200, so a change detector must confirm the page title/table, not just the status. robots disallows only `/www/search.do*`.
9. open.law.go.kr/robots.txt returns a "Page Not Found" page (no crawl rules published); law.go.kr robots allows all. No rate limit is published anywhere; use display=100, one request per second, cache by MST.
10. Amendment ordering: eflaw returns one row per effective-date stage, so the same MST appears several times; de-duplicate on (MST, 시행일자). A stage defined only in prose (decree 36121 "1 year after promulgation") may lack its own row.
11. The 표준약관 board has no machine-readable revision field; the revision date lives in the title and attachment name.

## 7. What still needs the OC key
- Production-grade calls from a fixed server (registration of IP and domain), quota knowledge, and the OC-string format.
- Anything beyond public samples if `OC=test` is later restricted; article-level checks (lawjosub, lsJoHstInf) and bulk 별표 downloads were not exercised because they add nothing for the spike.
- Human decision: reading the 2026.4 PDF you already hold to confirm the UNVERIFIED content claims in section 4.
