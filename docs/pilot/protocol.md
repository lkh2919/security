# InfoSec pilot protocol (design C8)

Status: PILOT. Small n. Nothing here is a validated benchmark. Korean version: `docs/ko/pilot/protocol.md`.

## 1. Goal

Measure 업무 효과성 for the contest without invented numbers: how many wall-clock minutes InfoSec reviewers need to (a) check an affiliate privacy policy against the rules and (b) assess the impact of a law amendment on policies, by the normal manual method versus the agent-assisted method (including human verification of the agent output), and how many findings each method misses or gets wrong against an expert key.

## 2. Participants

- 2 or 3 InfoSec reviewers, labelled R1, R2, (R3). Use these labels only, never names, in every file.
- 1 senior reviewer (K1) who builds the expert key together with the privacy-domain-expert agent. K1 should not also be a timed reviewer; if unavoidable, K1 does not time items they keyed, and this is stated in the results.

## 3. Items (8 in total)

Policy check (task_type `policy_check`): six captured Lotte policies, one or two per peer group in `kb/jurisdictions/kr/monitor/peers/peer-registry.json` (`groups[].lotte`):

| Item | Registry id | Group |
|------|-------------|-------|
| P1 | lotte-wellfood-privacy | food |
| P2 | lotte-department-store-privacy | retail |
| P3 | lotte-mart-privacy | retail |
| P4 | lotte-castle-privacy | chem_build_mfg |
| P5 | lotte-hotel-privacy | tour_service |
| P6 | lpoint-privacy | finance (membership; finance-specific law is out of scope, only PIPA and Network Act checks are keyed) |

Amendment impact (task_type `amendment_impact`): which policies and sections need action.

| Item | Amendment | Scope |
|------|-----------|-------|
| A1 | PIPA Act 제21445호 (in force 2026-09-11) | the six policies P1-P6 |
| A2 | Network Act 제21988호 (in force 2026-10-02) | the six policies P1-P6 |

The `item_id` used in all sheets is the registry id for P-items, `amend-21445` and `amend-21988` for A-items.

## 4. Arms

- **manual**: the reviewer's normal method (their usual tools, checklists, search). No agent output is visible.
- **agent**: the reviewer receives the agent report for the item (check/impact report with quotes and locations) and verifies it against the policy text, correcting wrong findings and adding missed ones. The final list after verification is what is scored. The time includes reading the report and all verification.

## 5. Counterbalancing

Split items into set S1 = {P1, P3, P5, A1} and set S2 = {P2, P4, P6, A2}. A reviewer never does the same item in both arms (no memory carry-over).

| Reviewer | S1 | S2 | Order |
|----------|----|----|-------|
| R1 | manual | agent | manual set first |
| R2 | agent | manual | agent set first |
| R3 (if any) | manual | agent | agent set first |

With only 2 reviewers, each item is timed in one arm by one reviewer, so arms are not paired per item; say so in the results. Run the agent exactly once per item before the pilot, with the config frozen, and keep its `usage.jsonl`.

## 6. Timing rules

- Wall clock, local time, HH:MM, recorded by the reviewer (or an observer) in `timing-sheet.csv`.
- Start: the moment the reviewer opens the item materials and begins reading (manual) or opens the agent report (agent).
- Stop: the moment the reviewer submits the final finding list for that item.
- Breaks (leaving the desk, calls, other work) are logged in `breaks_minutes` and excluded: `minutes = end - start - breaks_minutes`.
- Do not time setup (tool install, explanations) or the reading of this protocol.
- One item at a time; no multitasking. If an item is interrupted for more than 30 minutes, mark it in notes and do not use it in medians (list it separately).

## 7. What counts as a finding

One finding = one distinct problem in one section of one policy (or, for amendment tasks, one policy section needing change because of the amendment), with a section location and a short verbatim quote. The same problem repeated in several sections counts once per section. Style preferences and fact-dependent questions the policy cannot answer are not findings unless severity `confirm` is used for them in the key. Severity scale: critical, high, medium, low, confirm. Reviewers report severity too, but matching to the key is by section and problem, not severity.

## 8. Rework time

Rework = minutes spent after submission correcting findings because the senior reviewer or key comparison showed them wrong or incomplete, or (agent arm) time spent fixing agent output that was judged wrong. Record in `notes` as `rework=NN` and report separately; never fold it silently into `minutes`. Report "minutes plus rework" as a second column.

## 9. Expert key

- Built by K1 and the privacy-domain-expert agent (model `opus`) per item, BEFORE anyone sees agent output and before the timed sessions are scored.
- K1 reviews every key row. Disagreements are resolved by K1 and recorded in `notes`.
- File: `expert-key-template.csv` copied per pilot (`expert-key.csv`). Quotes are short (25 words or fewer).
- The key is frozen (date and time written in the file header note or commit) before scoring. Later additions are listed as "added after freeze" and reported separately.

## 10. Analysis

- Per item and arm: minutes, findings count. Per arm: median and range (min-max) of minutes across items, and per task type.
- Missed findings = key findings absent from the final list. Wrong findings = listed findings not supported by the policy text or contradicting the key (K1 decides).
- State n (reviewers, items, timed sessions) next to every number. Label everything "pilot".
- No means across tiny samples presented as typical; no significance claims.
- Extrapolation (hours per year, per affiliate) only with stated assumptions: the team's own policy count and amendment frequency, supplied by the team and marked as assumptions.
- Cost: only from the run's `usage.jsonl` (list-price USD). Reviewer time is not converted to money unless the team supplies a rate, labelled as an assumption.

## 11. Privacy and handling

- No personal data in logs, sheets, notes or quotes: no names, e-mails, phone numbers, employee IDs. Reviewers are R1-R3 only. Captured policies may contain public officer contacts; do not copy them into any sheet.
- Files stay internal (repository or internal share). Pilot reports are not published externally; only aggregate numbers go on slides.
- Run `bun scripts/pii-scan.ts` before any commit of pilot files.
