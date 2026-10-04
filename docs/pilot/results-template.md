# Pilot results (template)

Status: PILOT. Fill only from `timing-sheet.csv`, the frozen expert key and `usage.jsonl`. Leave a cell as `n/a` if it was not measured. Korean version: `docs/ko/pilot/results-template.md`.

Pilot facts: reviewers n = __ ; items n = __ ; timed sessions n = __ ; date = ____ ; key frozen at = ____ ; agent run id = ____

## 1. Minutes per item and arm

| Item | Task type | Reviewer | Arm | Minutes | Findings | Missed vs key | Wrong | Rework min |
|------|-----------|----------|-----|---------|----------|---------------|-------|------------|
| | | | | | | | | |

## 2. Summary per arm and task type

| Task type | Arm | n sessions | Median minutes | Range (min-max) | Median minutes + rework | Missed (total/key total) | Wrong (total) |
|-----------|-----|-----------|----------------|-----------------|-------------------------|--------------------------|---------------|
| policy_check | manual | | | | | | |
| policy_check | agent | | | | | | |
| amendment_impact | manual | | | | | | |
| amendment_impact | agent | | | | | | |

## 3. Cost of the agent path

| Run | Stages | Tokens (in/out) | List-price USD (from usage.jsonl) |
|-----|--------|-----------------|------------------------------------|
| | | | |

Source file: `runs/.../usage.jsonl` (path: ____). Copy totals, do not recompute by hand.

## 4. Scaling (assumptions only)

| Assumption | Value | Supplied by | 
|------------|-------|-------------|
| Policies reviewed per year | | InfoSec team |
| Amendments per year | | InfoSec team |

Any hours-saved figure = (median manual minutes - median agent minutes) x assumption, shown with the formula and the label "assumption-based estimate, not measured".

## 5. Caveats to state

Small n; reviewers not paired per item (unless R3 present); reviewer experience varies; agent run frozen once; key built by one senior reviewer; items are Lotte policies only.

## 6. Wording rules for contest slides

1. Every pilot number carries "pilot, n=<sessions> (<reviewers> reviewers, <items> items)" on the same slide, e.g. "pilot, n=8 sessions (2 reviewers, 8 items)". Fill the brackets from section above, never from memory.
2. Report medians with ranges ("median 42 min, range 25-70"), never a bare average, never a percentage improvement without both underlying medians shown.
3. No invented numbers: every figure traces to `timing-sheet.csv`, the key comparison or `usage.jsonl`. Not measured by 2026-10-23 means a labelled target ("target, not measured"), never a result.
4. Quality is stated with the cost of speed: always show missed and wrong findings versus the expert key next to the time.
5. Cost is quoted as "list-price USD from usage.jsonl, run <id>", not as an estimate.
6. Scaling claims are labelled "assumption-based estimate" and name the assumption and who supplied it.
7. No claim of statistical significance, no "proven", no "company-wide savings" from this pilot.
8. Aggregate numbers only: no reviewer names or labels linked to individual speeds on slides.
9. Peer-watch counts remain labelled "업계 동향(참고)" and are not part of pilot results.
