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
| 7-off | Add `masking: "off" \| "basic"` (default off); make the client `assertNoPii` gate optional (`piiGate`, default false); smoke script accepts an input path | done (PR #2) |
| 8 | Golden cases G1–G3 (+G1b, G2b), W1–W4, seeded defects D1–D8, rubric v1 | done for inputs, expectations, defect specs and rubric (`golden/cases`, `golden/defects`, `kb/jurisdictions/kr/rubric/rubric-v1.json`, `test/golden-cases.test.ts`, `test/rubric.test.ts`). Reference drafts (`golden/cases/*/reference/`) wait for the Row 11 drafters; the privacy-domain-expert reviews them before they become the baseline. House style is still candidate, so the rubric's houseStyle score is not assessed. |
| 9a | Anthropic client, R2 extract, C1 coverage, R3 gap | done |
| 10 | Renderer MD/HTML/DOCX + Reviewer Sheet | done |
| 12 | Law freshness watcher (`scripts/freshness-check.ts`) | done |
| O0 | Orchestrator and CLI: `stages/orchestrate` (`startRun`, `continueRun`), `scripts/run-pipeline.ts` | done, mock-tested end to end (interview rounds, resume, render, masking off/basic); live run needs the API key. Freshness stage is marked skipped (run `scripts/freshness-check.ts` on the original PC). |
| 9b | R4 clause matcher (`stages/match`: group classification, library loader, ranking, approved-only house style) | done; committed library has 0 vetted clauses, so every section falls back to the rule pack until the privacy-domain-expert vets clauses (`vetted` + `vettedAgainst` in the clause files) |
| 11 | Drafters R5P/R5T (clause-first), C2 checker, R7 isolated auditor, draft-C2-audit fix loop | done in code with mock-LLM tests (`stages/draft`, `stages/check`, `stages/audit`, `stages/loop`, `prompts/draft-*`, `prompts/audit`). Not yet run against the live API. C2 implements AST-native generic checks; the rule packs' `check.expr` pseudo-DSL is not evaluated (R7 covers those rules). |
| 13 | Golden-set regression and calibration | harness done. **Live G1 tuning via Claude Code (`--llm claude-code`, no API key), 8 runs**: blocking findings 19 -> 16 -> 6 -> 3 -> 3 -> 2 -> 1; deterministic findings 0; traceability 1.0. Run 8: privacy has 0 blocker/major (7 minor) but fails on auditor scores (legal 3, accuracy 3, clarity 3; pass needs 4/4/3); terms has 1 major (rejoin wait stated differently in two articles drafted separately). **Seeded defects D1-D8 (auditor calibration, live)**: recall 0.75 with audit prompt 1.0.0 (D6 missed because the auditor deferred to C2's lexicon hit; D8 reported under R-T06 instead of X-02), then 1.00 (8/8) with audit prompt 1.1.0; about USD 3.6 per full run. **Run 9 (after stage 1, 2026-10-01)**: terms 0 blocker/major (T06 now refers to the membership article for rejoin waits; T07 states 7 and 30 days), scores legal 4 / accuracy 3 / clarity 4; privacy has 1 major, the known Decree Art.45 gap in S16 (needs the original PC), scores legal 2 / accuracy 3 / clarity 4. Not yet run live: other cases, stability (3 runs), `--source extract`. Cost about USD 5-6 list price and 40 min per G1 run. |
| 14 | Router skill, README, operator guide, PPTX outline | next |
| 15 | Final QA, security scan | local part done: `docs/reports/2026-10-01-final-qa.md` (gates green, scan clean except finding 1). Freeze not declared: live regression (3 runs), freshness, clause vetting and house-style approval are open. |

Known state: root tsc and `bun test` are green. Open KB gap (pinned in `test/kb-integrity.test.ts`, `KNOWN_UNBOUND`): 11 clause variables have no interview slot
(document metadata such as announceDate/versionNumber/tableOfContents, and collectionMethods, siteUrl, pointPolicy, customerCenter). The privacy-domain-expert decides new slots vs renderer-filled metadata.

## Council stage 2 live results (2026-10-01/02, one run each, `--source expected`)

| Case | Privacy | Terms | Open blocker/major |
|------|---------|-------|--------------------|
| G1 | fail (2/3/3) | pass_with_warnings (4/4/4) | 1 (S02 access-log purpose; data fixed after the run) |
| G2 | fail (2/4/3) | n/a | 2: S20 remedy-agency contacts, S16 Decree Art.45 (both KB gaps) |
| G3 | fail (2/4/3) | pass-level scores (4/4/4) | 1: S16 Decree Art.45 (KB gap) |
| G1b, G2b | rerun pending on the latest code | | |
| W1-W4 | warn sections correct | | gate changed: W cases are judged on warn-only bodies, not traceability |

Fixed during stage 2: effective date as a ledger fact in the regression; per-article terms applicability
(T09/T10 paid, T12 UGC); privacy task facts shared across S02/S03/S05; S07/S09 candidate rows for
ambiguous parties; T13 refers to the policy by title without a link; golden G-case inputs enriched.
What blocks a full G pass now is KB content, not prompts: verified Decree Art.45 ref for S16 (R-S16-006)
and a verified `statutes/remedy-agencies.json` for S20 (original PC / privacy-domain-expert).

## law.go.kr access (updated 2026-10-01)

- The cloud environment reaches law.go.kr once `www.law.go.kr` is allowed in the environment's Network access; the
  OC key then works from the cloud (no IP binding observed). Earlier 403s were the cloud network policy, not the key.
- The OC key is not in the repository. Set `LAW_GO_KR_OC` as an environment secret (cloud) or in `.env` (local).
- Freshness run 2026-10-01: DRIFT. Action item: 정보통신망법 amendment 제21988호 (promulgated 2026-09-29, in force
  2026-10-02) must be reviewed by the privacy-domain-expert. The other warnings are amendments already reflected (PIPA,
  its Decree, ECA 2026-07-21) and missing manifest stamps (ECA Decree, guideline pages, KFTC pages). Some calls drop
  through the proxy (socket closed); rerun or retry when a source reports unreachable.
- Raw sources under `kb/_sources/` are still only on the original PC (gitignored).

## Live-run findings that need a person (KB or design gaps, not prompt tuning)

- **Interview Template has no slots** for cookie refusal steps / retention / items (S14), and no KB of statutory remedy agencies (S20: names, phone numbers, URLs). G1 supplies these values by hand; real interviews cannot extract them. The privacy-domain-expert should add slots and a verified `statutes/remedy-agencies.json`.
- **Rule-pack legalRefs carry only article/paragraph/item, not what each item covers.** The drafter sometimes attaches an item-level citation to the wrong element (for example ECA 17(2) item 5). Prompts 1.3.0 tell it to use paragraph-level IDs when unsure; the durable fix is a verified `covers` note per legal ref.
- **PG / payment provider** is an ambiguous party type by user decision (always manual review, both candidates shown in S07 and S09). The drafter currently writes a manual-review note only; it does not yet draft the two candidate rows. G1 avoids the case (bank transfer only); add a golden case for it.
- **Rule-pack key notation**: `PIPA:2(2)` was fixed to `PIPA:2[2]` (2026-10-01, manifest re-stamped). A scan of every legal-ref key against its `paragraph`/`item` fields found no other mismatch.
- **S16 agents ref (fixed 2026-10-01)**: R-S16-006 now cites PIPA 38(1), Decree 45(1)/(2) and PIPA 36(1), read on law.go.kr (Decree 제36671호, Act 제21445호, both in force 2026-09-11); manifest re-stamped.
- **Cross-section consistency** (stage 1 of the 2026-10-01 council plan): terms calls get a `documentOutline` (which sibling article owns which fact slots) and, on fix passes, `relatedSections` (current text of articles a finding names); draft-terms prompt 1.6.0 tells the drafter to restate an owned fact completely or refer to its article. C2 `evidence.repeated_values` flags a period (rejoin waits, terms-change notice) that differs from the ledger or between articles (`stages/check/consistency.ts`).
- Lexicon `suppress` patterns (20 entries) were added from live drafts; extend them the same way when a lawful sentence is flagged, and keep every `testPositive` flagged (test).

## What the next session should do first

0. Long live runs: `bun scripts/golden-batch.ts --cases G2,G3,W1` runs one case per process and, on a Claude Code usage limit, sleeps until the reset time and retries (exit 3 with the remaining cases if the wait exceeds `--max-wait-min`, default 110).
0. Backend choice: no API key is needed. `bun scripts/<script> --llm claude-code` runs on the Claude Code login; `--llm api` or `ANTHROPIC_API_KEY` uses the API.
1. Pull `claude/stoic-darwin-b7yuee`; `bun install` sets `core.hooksPath` to `.githooks` (PII pre-commit guard) ([PR #2](https://github.com/lkh2919/security/pull/2)); run `bun install`, `bun x tsc --noEmit`, `cd packages/core && bun test` (expect 763 pass).
2. `bun scripts/smoke-extract.ts --llm claude-code` (passes), then `bun scripts/golden-regression.ts --cases G1 --runs 1 --no-defects`, then the full set with `--runs 3`. Tune prompts only where a gate metric fails (max 3 loops per defect class).
3. Human gates: vet clauses (privacy-domain-expert), approve house style (user), review `golden/cases/*/reference/` once the first live drafts exist.
4. On the original PC: `bun scripts/freshness-check.ts`. If `scripts/capture-lotte.ts` / `build-clauses.ts` are rerun, redact the officer contact lines of the capture index again (QA report finding 1).

## Open items for the user

- Optional: InfoSec-annotated approved policies (for rubric calibration), a sample interview mp3, the InfoSec form.
- House-style candidates (19 rules) need the user's approval; until then no house-style rule is enforced.
- Done 2026-10-01: personal names, e-mail and phones in the capture index were replaced (QA report finding 1). Do not rebuild the index from raw captures without redacting again.
