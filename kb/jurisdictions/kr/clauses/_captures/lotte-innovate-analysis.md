# Lotte Innovate public policies: structure and house-style observations

Status: DRAFT analysis by kb-curator (2026-09-30). Nothing here is approved; the user is the final approver of house-style rules (DEC-20260929-02). Section ids below are the provisional privacy rule-pack ids (`rulepacks/privacy-2026.04/index.json`) used only as topic hints for Row 6b.

## 1. Documents captured

| id | page | printed version / dates | capture |
|----|------|-------------------------|---------|
| `lotteinnovate-privacy` | lotteinnovate.com/ko/tos/privacyPolicy | V4.7, announced and effective 2026-06-25 (selector lists v3.4 to v4.7) | ok, 8.2k chars |
| `lotteinnovate-privacy-cctv` | lotteinnovate.com/ko/tos/privacycctv | V2.0, announced 2026-01-09, effective 2026-01-16 (selector v1.0 to v2.0) | ok, 3.7k chars |
| `lotteinnovate-cloud-privacy` | cloud.ldcc.co.kr/privacy-policy/ | unknown | failed_network (connection refused/timeout) |

- The corporate site publishes no terms of use (`이용약관`); the footer "ETC" menu holds only these two documents.
- Both pages load a static HTML fragment (`/html/policy/ko/v-4.7.html`, `/html/privacycctv/ko/v-2.0.html`) client-side; the script captures the fragment. robots.txt allows everything.
- Scope note: the policy covers only the corporate homepage services (customer inquiry, whistleblowing hotlines, subcontract dispute mediation, download center, IR meeting booking). It is not a general customer-service policy.

## 2. Section presence (privacy policy V4.7)

| Guideline topic (provisional id) | Present | Where / remark |
|----------------------------------|:-------:|----------------|
| Title and preamble (S01) | yes | Preamble in two paragraphs; then a summary card block ("major processing" labels) |
| Purposes (S02) | yes | Heading 1, sub-items lettered by service |
| Items collected (S03) | yes | Heading 2, split "without consent" and "with consent" tables, plus generated logs and collection method |
| Children under 14 (S04) | no | Absent |
| Retention (S05) | yes | Heading 3; per service with legal basis and period |
| Destruction (S06) | yes | Heading 8, procedure and method |
| Third-party provision (S07) | yes | Heading 4, table (recipients, purpose, items, retention) |
| Additional use criteria (S08) | no | Absent |
| Delegation (S09) | yes | Heading 5, two-column table (vendor, task) |
| Overseas transfer (S10) | yes | Heading 6 with items a to g in the statutory order (items, country, timing/method, recipient, purpose/period, basis, refusal effect) |
| Security measures (S11) | yes | Heading 9: managerial, technical, physical |
| Sensitive info disclosure (S12), pseudonymized data (S13) | no | Absent |
| Automatic collection devices / cookies (S14) | yes | Nested under heading 2 (2-3 b), not its own heading |
| Third-party behavioral data (S15), automated decisions (S17), domestic agent (S19), AI appendix (A1) | no | Absent |
| Rights and exercise (S16) | yes | Heading 7, lettered a to d, includes power-of-attorney form reference |
| Privacy officer and department (S18) | yes | Heading 10: officer (name, position, email) and department |
| Remedies (S20) | yes | Inside heading 10 as a list of external bodies with phone numbers |
| CCTV (S21/S22) | separate document | Own policy page, 11 headings (installation basis, coverage, managers, retention, viewing, rights, security, delegation, secrecy, change) |
| Voluntary items (S23) | partly | Summary card block only |
| Change notice (S24) | yes | Heading 11, plus a version-history comparison table |

Gaps for Row 6b/privacy-domain-expert to weigh (observations, not legal conclusions): no children section, no pseudonymized-data or behavioral-data section, no explicit rights-of-transmission wording, and the preamble still cites the Network Act by its old title.

## 3. Wording and format conventions observed

- **Numbering**: main headings as `N. title` (1 to 11); sub-items `가. 나. 다.`; tables under `2-1`, `2-2`, `2-3`. The table of contents uses zero-padded `01.` to `11.` and appears twice in the fragment (once hidden), so cleaning must de-duplicate it.
- **Tone**: polite declarative `~합니다` / `~하고 있습니다`, future commitments `~할 것입니다`; rights list in noun form.
- **Defined terms**: the company is `회사` (defined in the first sentence as 롯데이노베이트 주식회사); the reader is mostly `이용자`, with `정보주체` in the rights and items sections. The two are mixed.
- **Front summary**: a five-card "key points" block (items, purposes, retention, destruction, security, complaint contact) precedes the numbered body; each card ends with a pointer to the full text.
- **Tables**: consent-free and consent-based items in separate tables with the PIPA legal basis in a merged header cell; third-party and delegation lists as tables. Per-service retention uses text lists (`보존 근거` / `보존 기간`).
- **Retention presentation**: short fixed periods per service (3 months, 1 year, 3 years) with a statutory basis line where a law applies.
- **Overseas transfer**: written as a lettered checklist mirroring the mandatory disclosure items.
- **Contact block**: role title plus function email, not phone; complaint-agency list with domain names and short numbers.
- **Change notice and history**: notice via the homepage announcements; `공고일자`, `시행일자`, `버전번호` (V4.7) lines; then an old/new/summary table listing only changed clauses; the site keeps all earlier versions selectable.
- **Personal data in source**: the page prints a named officer and a named overseas contact. Clause records must replace these with slots.

## 4. DRAFT house-style rule candidates (not approved)

| id | scope | kind | Candidate rule | Source |
|----|-------|------|----------------|--------|
| H-01 | privacy | deterministic | Open with a two-sentence preamble defining `회사` and stating the laws complied with. | privacy V4.7 preamble |
| H-02 | privacy | deterministic | Number main headings `N. title`; sub-items `가. 나. 다.`; table groups `N-1`. | headings |
| H-03 | privacy | deterministic | Place a key-points summary block (items, purposes, retention, destruction, security, complaint contact) before the numbered body. | summary cards |
| H-04 | privacy | llm | Use polite declarative `~합니다`; avoid `~한다` in policy text. | body text |
| H-05 | privacy | deterministic | Use `회사` for the operator; use `정보주체` in the rights and legal sections and `이용자` elsewhere, consistently within one document. | defined terms |
| H-06 | privacy | deterministic | Present consent-free and consent-based items as two tables with the legal basis in the header. | 2-1, 2-2 |
| H-07 | privacy | deterministic | List third-party provision and delegation in tables; delegation table has at least vendor and task columns. | 4, 5 |
| H-08 | privacy | deterministic | Write the overseas-transfer section as lettered items a to g in the statutory order. | 6 |
| H-09 | privacy | deterministic | State each retention as period plus legal basis line when a statute applies. | 3 |
| H-10 | privacy | deterministic | End with the change notice, then announcement date, effective date and version number lines (`공고일자`, `시행일자`, `버전번호`). | 11 |
| H-11 | privacy | llm | Add an old/new comparison table for each revision listing only changed clauses. | change history |
| H-12 | privacy | deterministic | Give officer and department contact as role plus email; never a personal name inside the reusable clause text. | 10 |
| H-13 | both | deterministic | Keep video-surveillance rules in a separate document with its own version line. | CCTV page |

## 5. Provisional topicHints for Row 6b (from this site)

`lotteinnovate-privacy`: 1 -> S02, 2 -> S03 (2-3 b -> S14), 3 -> S05, 4 -> S07, 5 -> S09, 6 -> S10, 7 -> S16, 8 -> S06, 9 -> S11, 10 -> S18 and S20, 11 -> S24. `lotteinnovate-privacy-cctv`: whole document -> S21. Provisional; Row 6b owns the final mapping.
