# Handoff — privacy-agent (snapshot 2026-10-01, updated after the cloud session)

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
| 6b | Clause library normalization, house-style candidates, manifest | done: 153 clauses validate (`bun scripts/validate-clauses.ts`), manifest and candidates present. Open: user approval of house style; vetting of clauses (none vetted); 9 clauses with unbound variables (see KB gap) |
| 7 | Intake (STT adapter, segmenter, form parser, masker) | done, but a masking rework was interrupted |
| 7-off | Add `masking: "off" \| "basic"` (default off); make the client `assertNoPii` gate optional (`piiGate`, default false); smoke script accepts an input path | done (PR #1) |
| 8 | Golden cases G1–G3 (+G1b, G2b), W1–W4, seeded defects D1–D8, rubric v1 | done for inputs, expectations, defect specs and rubric (`golden/cases`, `golden/defects`, `kb/jurisdictions/kr/rubric/rubric-v1.json`, `test/golden-cases.test.ts`, `test/rubric.test.ts`). Reference drafts (`golden/cases/*/reference/`) wait for the Row 11 drafters; the privacy-domain-expert reviews them before they become the baseline. House style is still candidate, so the rubric's houseStyle score is not assessed. |
| 9a | Anthropic client, R2 extract, C1 coverage, R3 gap | done |
| 10 | Renderer MD/HTML/DOCX + Reviewer Sheet | done |
| 12 | Law freshness watcher (`scripts/freshness-check.ts`) | done |
| O0 | Orchestrator and CLI: `stages/orchestrate` (`startRun`, `continueRun`), `scripts/run-pipeline.ts` | done, mock-tested end to end (interview rounds, resume, render, masking off/basic); live run needs the API key. Freshness stage is marked skipped (run `scripts/freshness-check.ts` on the original PC). |
| 9b | R4 clause matcher (`stages/match`: group classification, library loader, ranking, approved-only house style) | done; committed library has 0 vetted clauses, so every section falls back to the rule pack until the privacy-domain-expert vets clauses (`vetted` + `vettedAgainst` in the clause files) |
| 11 | Drafters R5P/R5T (clause-first), C2 checker, R7 isolated auditor, draft-C2-audit fix loop | done in code with mock-LLM tests (`stages/draft`, `stages/check`, `stages/audit`, `stages/loop`, `prompts/draft-*`, `prompts/audit`). Not yet run against the live API. C2 implements AST-native generic checks; the rule packs' `check.expr` pseudo-DSL is not evaluated (R7 covers those rules). |
| 13 | Golden-set regression and calibration | harness done and mock-tested (`src/eval`, `scripts/golden-regression.ts`, gate = design R11.2). **Live calibration not run**: needs `ANTHROPIC_API_KEY`; run `bun scripts/golden-regression.ts --cases G1 --runs 1 --no-defects` first, then the full set with `--runs 3`. Max 3 tuning loops per defect class. |
| 14 | Router skill, README, operator guide, PPTX outline | next |
| 15 | Final QA, security scan | local part done: `docs/reports/2026-10-01-final-qa.md` (gates green, scan clean except finding 1). Freeze not declared: live regression (3 runs), freshness, clause vetting and house-style approval are open. |

Known state: root tsc and `bun test` are green. Open KB gap (pinned in `test/kb-integrity.test.ts`, `KNOWN_UNBOUND`): 11 clause variables have no interview slot
(document metadata such as announceDate/versionNumber/tableOfContents, and collectionMethods, siteUrl, pointPolicy, customerCenter). The privacy-domain-expert decides new slots vs renderer-filled metadata.

## What only works on the original PC

- law.go.kr calls (freshness watcher, statute fetches): the OC key is bound to the registered IP.
- Raw sources under `kb/_sources/` (guideline text, Lotte captures, statute texts) are gitignored and not in the repo.
  Rebuilding clauses from raw captures, re-capturing, or re-reading statutes must run on that PC.
  Everything derived from them (rule packs, clause records, captures index, analyses) is committed.

## What the next session should do first

1. Pull `claude/stoic-darwin-b7yuee` ([PR #1](https://github.com/lkh2919/security/pull/1)); run `bun install`, `bun x tsc --noEmit`, `cd packages/core && bun test` (expect 713 pass).
2. With `ANTHROPIC_API_KEY` in `.env`: `bun scripts/smoke-extract.ts`, then `bun scripts/golden-regression.ts --cases G1 --runs 1 --no-defects`, then the full set with `--runs 3`. Tune prompts only where a gate metric fails (max 3 loops per defect class).
3. Human gates: vet clauses (privacy-domain-expert), approve house style (user), review `golden/cases/*/reference/` once the first live drafts exist.
4. On the original PC: `bun scripts/freshness-check.ts`; decide finding 1 of the QA report (personal data in the capture index).

## Open items for the user

- Optional: InfoSec-annotated approved policies (for rubric calibration), a sample interview mp3, the InfoSec form.
- House-style candidates (19 rules) need the user's approval; until then no house-style rule is enforced.
- Decide what to do with the named executive and e-mail in `kb/jurisdictions/kr/clauses/_captures/index.json` (QA report finding 1).
