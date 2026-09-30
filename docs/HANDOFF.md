# Handoff — privacy-agent (snapshot 2026-10-01)

Read this first when you continue this project in a new session (local or cloud).

## What this is

A multi-agent harness and a TypeScript core library that drafts a Korean privacy policy
(개인정보처리방침) and terms of service from a service-description intake sheet and an
interview transcript. It follows the PIPC guideline (April 2026), uses a Lotte-group public
policy clause library, checks law freshness through the law.go.kr Open API, and runs an
independent audit before rendering MD/HTML/DOCX plus a Reviewer Sheet for the InfoSec office.

- Approved design: `docs/designs/2026-09-29-privacy-policy-agent-team-design.md` (R15 = row plan).
- Decisions: `docs/decisions/DEC-20260929-01.md`, `DEC-20260929-02.md`.
- Team roster and skills: `AGENTS.md`, `agents/`, `skills/`. The session acts as PM and dispatches specialists.

## Working rules

- Speed first: start any row whose inputs exist; run independent rows in parallel on disjoint folders.
- Gates: `bun x tsc --noEmit` at the root and `bun test` in `packages/core`. Check exit codes directly.
- English for `.md` outside locale folders (`ko/`). Korean is fine inside JSON values.
- Never print or commit secrets. `.env` holds `LAW_GO_KR_OC` (law.go.kr key) and optionally `ANTHROPIC_API_KEY`.
- The user personally approves Lotte house-style rules.

## User decisions (2026-09-29 .. 2026-10-01)

- Korea only. Privacy policy plus terms of service. Finance affiliates excluded; loyalty/membership (L.POINT) included.
- Robots-blocked sites excluded (LOTTE ON, Homeshopping, Duty Free, Chemical).
- Delegation vs third-party provision ambiguity: always flag for manual review.
- Intake sheet (사전 작성지) is part of Phase 1.
- HR statutory retention and Act 21445 (in force 2026-09-11) rules are in scope.
- **Masking: OFF by default** (user decision 2026-09-30). Premises: interviewees do not disclose sensitive internal
  information, and intake-sheet data will be published anyway. Keep sanitization and the untrusted-data fence.
  The existing masker stays available as an opt-in `"basic"` mode.
- Vercel, web UI, portable zip and STT vendor selection are deferred.

## Row status

| Row | Scope | Status |
|-----|-------|--------|
| 1 | Scaffold | done |
| 2 | Hires (privacy-domain-expert, kb-curator) + 16 skills | done |
| 3 | Law research spike (`docs/reports/2026-09-29-law-spike-report.md`) | done |
| 4a | Privacy rule packs S01–S24, A1; interview template v1 | done |
| 4b | Terms rule packs T01–T15; unfair-clause lexicon | done |
| 4c | Intake sheet, delegation flag, HR retention, Act 21445 | done |
| 5 | Zod contracts, model registry, run store, stage cache | done |
| 5b | Integrate `src/index.ts` exports; rule-pack/house-style/clause/manifest schemas; `applyAnswers`; KB integrity test; fix root scripts | done (`stages/interview/apply-answers.ts`, `test/kb-integrity.test.ts`) |
| 6a | Lotte corpus capture (47 index entries) | done |
| 6b | Clause library normalization, house-style candidates, manifest | **interrupted — check partial output in `kb/jurisdictions/kr/clauses/{privacy,terms}` and finish** |
| 7 | Intake (STT adapter, segmenter, form parser, masker) | done, but a masking rework was interrupted |
| 7-off | Add `masking: "off" \| "basic"` (default off); make the client `assertNoPii` gate optional (`piiGate`, default false); smoke script accepts an input path | done (PR #1) |
| 8 | Golden cases G1–G3 (+G1b, G2b), W1–W4, seeded defects D1–D8, rubric v1 | done for inputs, expectations, defect specs and rubric (`golden/cases`, `golden/defects`, `kb/jurisdictions/kr/rubric/rubric-v1.json`, `test/golden-cases.test.ts`, `test/rubric.test.ts`). Reference drafts (`golden/cases/*/reference/`) wait for the Row 11 drafters; the privacy-domain-expert reviews them before they become the baseline. House style is still candidate, so the rubric's houseStyle score is not assessed. |
| 9a | Anthropic client, R2 extract, C1 coverage, R3 gap | done |
| 10 | Renderer MD/HTML/DOCX + Reviewer Sheet | done |
| 12 | Law freshness watcher (`scripts/freshness-check.ts`) | done |
| 9b | R4 clause matcher | next (after 6b) |
| 11 | Drafters R5P/R5T (clause-first), C2 checker, R7 isolated auditor | next |
| 13 | Golden-set regression and calibration | next |
| 14 | Router skill, README, operator guide, PPTX outline | next |
| 15 | Final QA, security scan | next |

Known state: root tsc and `bun test` are green. Open KB gap (pinned in `test/kb-integrity.test.ts`, `KNOWN_UNBOUND`): 11 clause variables have no interview slot
(document metadata such as announceDate/versionNumber/tableOfContents, and collectionMethods, siteUrl, pointPolicy, customerCenter). The privacy-domain-expert decides new slots vs renderer-filled metadata.

## What only works on the original PC

- law.go.kr calls (freshness watcher, statute fetches): the OC key is bound to the registered IP.
- Raw sources under `kb/_sources/` (guideline text, Lotte captures, statute texts) are gitignored and not in the repo.
  Rebuilding clauses from raw captures, re-capturing, or re-reading statutes must run on that PC.
  Everything derived from them (rule packs, clause records, captures index, analyses) is committed.

## Open items for the user

- Optional: InfoSec-annotated approved policies (for rubric calibration), a sample interview mp3, the InfoSec form.
- House-style candidates need the user's approval once Row 6b finishes.
