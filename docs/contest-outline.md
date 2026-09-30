# Contest deck outline (PPTX)

Audience: Lotte Innovate AX contest, Track A (process innovation). Deadline 2026-10-23. Judging: business effect 30, AI fit 30, completeness 20, company-wide applicability 20. Source material: design R1 (problem), R3 (pipeline), R5.3 (clause library), R8 (output), R10 (token efficiency), R11 (quality plan). Numbers marked `[measure]` come from the Row 13 live calibration; do not present design estimates as measurements.

## Slide plan (10 slides)

| # | Title | Message | Evidence to show | Criterion |
|---|-------|---------|------------------|-----------|
| 1 | The problem | Every service needs a privacy policy and terms that follow the 2026 amendments; drafting is slow and inconsistent across affiliates | Amendment timeline (Act 21445 in force 2026-09-11); today's manual steps | Business effect |
| 2 | The idea | An interview plus a form become a reviewed reference draft, with InfoSec review instead of InfoSec drafting | One-line flow: interview, facts, gaps, draft, audit, render | Business effect |
| 3 | How it works | Code does what must be exact; models do what needs language | Pipeline diagram (R3): 8 runtime agents, which are code, Haiku, Sonnet, Opus | AI fit |
| 4 | Facts you can trace | Every fact carries a verified quote; the drafter cannot invent one | Ledger example: slot, quote, segment id; C2 evidence check | AI fit |
| 5 | Lotte's own clauses | Clause-first drafting from the group's public policies, with provenance | Coverage matrix (section by business group, vetted clause count) `[measure after vetting]` | Company-wide applicability |
| 6 | An auditor that cannot be talked into it | Independent Opus auditor sees only an allowlisted envelope; seeded defects prove it | Envelope key list; D1-D8 recall `[measure]` | AI fit |
| 7 | Honest about what it does not know | Unknown gates, children, CCTV, gen-AI, location and delegation-vs-provision become manual-review items | Reviewer Sheet screenshot | Completeness |
| 8 | Cost and time | Token budget per stage, clause-first share, cache reuse | Measured tokens and cost per run `[measure]`; design estimate only as a labelled target | Business effect |
| 9 | Quality gate | Golden set G1-G3, W1-W4, D1-D8 with hard thresholds (R11.2) | Gate table: applicability 100%, slot recall 0.90, defect recall 0.90 `[measure]` | Completeness |
| 10 | Roll-out | Same pipeline for other affiliates: new business group means new vetted clauses, not new code; Phase 2 candidates | Affiliate list, finance excluded in Phase 1, what needs legal sign-off | Company-wide applicability |

## Speaker notes (short)

- Open with the fact that the output is a draft for review, not legal advice; say so once, clearly.
- Show one real before/after only if the data is synthetic or already public.
- On slide 6, say that the auditor's prompt and rubric are never visible to the drafters and show the unit test that asserts it.
- Close with the open items the company owns: house-style approval, clause vetting, privacy-officer review of manual-review items.

## Before building the deck

1. Run the live calibration (`bun scripts/golden-regression.ts`) and fill every `[measure]` cell.
2. Have the privacy-domain-expert vet at least the clauses behind slide 5.
3. Take screenshots from a real run of the synthetic G1 case.
