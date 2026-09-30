# Coverage Matrix: privacy-2026.04 rule packs vs Interview Template v1

Source: PIPC, Privacy Policy Drafting Guideline, 2026.4 (Part III sections 1-24, Appendix 1), paraphrased. Template: `../../interview/template-v1.json` v1.0.0. Checked on 2026-09-29 and again on 2026-09-30 (Row 4c) by a validation script: 0 errors, 0 warnings. Row 4c also checks the intake sheet (every field maps to an existing slot and column, every pre-answered node exists and targets that table's slots, no `must` node is skipped) and `statutes/retention-periods.json`. The script checks that all JSON parses, that node, slot and legal-ref keys resolve, that every M and C item has a `must` node, and that every node referenced by a pack exists.

Class: **M** always · **C** when the processing applies, otherwise a "not processed" statement (or omit) · **R** recommended. The Rules column shows `must` rules / total rules.

| ID | Section | Class | Handling | Rules | `must` nodes | `should` / `may` nodes |
|----|---------|-------|----------|-------|--------------|------------------------|
| S01 | Title and preamble | M | clause | 2/6 | Q-P-01, Q-P-02, Q-P-03, Q-T13-17 | - |
| S02 | Processing purposes | M | llm | 4/6 | Q-P-04, Q-P-05, Q-S02-01, Q-S02-03, Q-S02-40, Q-S02-60, Q-A1-50 | Q-S02-02, Q-S02-30 |
| S03 | Items processed | M | llm | 7/9 | Q-P-04, Q-P-05, Q-S02-03, Q-S03-01, Q-S03-03, Q-S03-04, Q-S03-05, Q-S03-06, Q-S03-40, Q-S03-41, Q-S02-60, Q-A1-51 | Q-S02-02, Q-S03-20, Q-S03-30, Q-S02-30, Q-S03-07 |
| S04 | Children under 14 | C (warn) | warn | 2/5 | Q-S04-01 (gate), Q-S04-80, Q-T06-06 | Q-S04-81, Q-S04-82, Q-S14-83 |
| S05 | Processing and retention period | M | llm + statute table | 5/7 | Q-S05-01, Q-S05-02, Q-S05-20, Q-S05-30, Q-S05-40, Q-S05-41, Q-S02-60, Q-A1-51 | Q-S02-02, Q-S05-03, Q-S05-21, Q-S05-31 |
| S06 | Destruction procedure and method | M | clause | 3/4 | Q-S06-01, Q-S05-02, Q-S05-40, Q-S05-41 | Q-S06-02 |
| S07 | Provision to third parties (conditional typing, 2026.4) | C | llm | 4/7 | Q-S07-01 (gate), Q-S07-02, Q-S09-05, Q-S09-06, Q-S09-20, Q-S07-60 | Q-S07-03 |
| S08 | Ongoing additional use or provision | C | llm | 2/3 | Q-S08-01 (gate), Q-S08-02, Q-S08-03, Q-A1-52 | - |
| S09 | Outsourcing (conditional typing, 2026.4); flag `ambiguity.delegation_vs_provision` | C | llm + manual flag | 3/7 | Q-S09-01 (gate), Q-S09-02, Q-S09-05, Q-S09-06, Q-S09-20, Q-A1-54 | Q-S09-03, Q-S09-04, Q-S09-40 |
| S10 | Overseas collection and transfer | C | llm | 6/7 | Q-S10-01, Q-S10-02 (gates), Q-S10-70 to Q-S10-76, Q-S09-06, Q-A1-54 | Q-S10-77 |
| S11 | Safety measures | M | clause checklist | 2/3 | Q-S11-01 | - |
| S12 | Sensitive-data disclosure risk | C | llm | 2/3 | Q-S12-01 (gate), Q-S12-02, Q-S03-06 | - |
| S13 | Pseudonymized information | C | llm | 6/6 | Q-S13-01 (gate), Q-S13-02, Q-A1-52 | - |
| S14 | Automatic collection devices | C | clause | 4/7 | Q-S14-01 (gate), Q-S14-02, Q-S14-03, Q-S14-60 | Q-S14-04, Q-S14-61, Q-S14-62, Q-S14-83 |
| S15 | Third-party behavioral data | R+C | clause | 0/4 | - (R item) | Q-S15-01 (gate), Q-S15-60 |
| S16 | Rights of data subjects | M | clause | 4/7 | Q-S16-01, Q-S16-03, Q-S16-04, Q-P-03, Q-A1-53 | Q-S16-02 |
| S17 | Automated decisions | C | llm + manual flag | 5/6 | Q-S17-01 (gate), Q-S17-50 to Q-S17-53, Q-S03-06 | - |
| S18 | Privacy officer and complaint department (+ Act 21445 rules, beyond guideline) | M | clause | 2/7 | Q-S18-01, Q-S18-02, Q-P-01 | Q-S18-03 |
| S19 | Domestic representative | C | clause | 2/3 | Q-S19-01, Q-S19-02 (gates), Q-S19-03 | - |
| S20 | Remedies | R | clause | 1/4 | Q-S18-02 (contact reuse) | Q-S20-01 |
| S21 | Fixed video devices | C (warn) | warn | 1/3 | Q-S21-01 (gate), Q-S21-90, Q-S21-91 | Q-S21-92 |
| S22 | Mobile video devices | C (warn) | warn | 1/3 | Q-S22-01 (gate), Q-S22-94, Q-S22-95 | - |
| S23 | Voluntary items | R | llm (optional) | 1/3 | - (R item) | Q-S23-01, Q-S05-31, Q-S23-57 |
| S24 | Policy changes (change-notice method, 2026.4) | M | clause | 3/5 | Q-S24-01, Q-S24-02, Q-S24-03, Q-P-03 | Q-S09-04 |
| A1 | Gen-AI appendix (new 2026.4; R-A1-011 from Act 21910, upcoming 2027-03-09) | C (warn-only) | warn | 0/11 | Q-A1-01 (gate), Q-A1-50 to Q-A1-54 | Q-A1-55, Q-A1-56, Q-A1-57, Q-S23-57 |
| X1 | Location information | C (warn) | no pack | - | - | Q-X1-01, Q-X1-96 |

Terms topics (catalog only; rule details `pending_row_4b`): T01 Q-T01-01 · T02 Q-T02-02 · T03 Q-T03-03 · T04 Q-T04-04 · T05 Q-T05-05 · T06 Q-P-05, Q-T06-06 · T07 Q-T07-07 · T08 Q-T08-08 · T09 Q-T09-09 to Q-T09-11 · T10 Q-T10-12, Q-T10-13 · T11 Q-T11-14 · T12 Q-T12-15, Q-T12-16 · T13 Q-T13-17 · T14 Q-T14-18 · T15 Q-T15-19.

## 2026.4 changes recorded

- **Conditional typing** (R-S07-005, R-S09-004): recipient or processor *types* are allowed only when the data subject can see the actual party in a service menu or my-page; the policy then gives the access path. The `conditionalTyping` block in S07/S09 lists the three disclosure modes.
- **Change-notice method** (R-S24-002 to R-S24-005): version list with application periods; a before/after comparison table for rights-affecting changes, before or at revision; batched notice of minor list changes over a reasonable window (example: 4 weeks) with start and end dates.
- **Gen-AI appendix** (A1): intended use, prompt and output storage, training use, retention split, opt-out and limits, external model outsourcing and overseas transfer, filtering, feedback.
- **Dated amendments (Row 3 spike, law.go.kr)**: `effectiveFrom` metadata on R-S16-005 (Art. 35-2, 2025-03-13), R-S17-001/005 (Art. 37-2, 2024-03-15), R-S19-001/003 (Act 20897, 2025-10-02), and R-A1-011 (Art. 28-12(5), **upcoming 2027-03-09**, warn-only).

## Row 4c additions (2026-09-30)

- **Intake sheet**: `../../interview/intake-sheet-v1.json` (12 tables, 92 fields, 78 pre-answered nodes). Typical B2C with the sheet: about 33 minutes for `must` nodes and 48 minutes with `should` nodes (heuristic read-back costs, uncalibrated).
- **Flag `ambiguity.delegation_vs_provision`** (S09 `flags`; rules R-S09-007, R-S07-007): PG, marketplace sellers, external LLM/API vendors and plug-ins/SDKs are never auto-classified. The draft carries both candidate rows and a Korean reviewer message.
- **Beyond the guideline** (`beyondGuideline: true`, verified on law.go.kr): R-S18-005 to R-S18-007 (Act 21445, in force 2026-09-11; no change to mandatory policy items), R-S05-007 with verified HR retention hints (`../../statutes/retention-periods.json`), R-A1-011 wording from PIPA 28-12(5) (Act 21910, 2027-03-09).
- **Resolved**: NV-S06-01 (current safety-measures notice is 제2026-9호; 제2025-9호 superseded), NV-S18-01, NV-A1-02, NV-S09-01; NV-S05-02 partly.

## Guideline parts not fully mapped

1. **Part IV (publication methods, pp.88-104) and Part V (labeling, pp.108-116)**: not Part III sections. S01 `publicationNotes` summarizes the Part II publication rules only; labeling icons are not modelled.
2. **Appendix 2 (children's policy)**: referenced by R-S04-004 only; there is no pack for child-friendly wording.
3. **Appendices 3-5** (public institutions, small-business example, industry guides): out of scope for Phase 1 (private-sector online services).
4. **Appendices 6-9 and the S14/S15 browser steps**: not encoded, because menu paths are volatile. They need a maintained clause with freshness checks.
5. **Industry retention examples** (medical, academy, travel in S05): only e-commerce, communications-records and verified HR/tax/OSHA/hiring periods are included in `statuteHints`.
6. **S16 transmitter scope, S19 designation thresholds, S21/S22 installation bases**: applicability details depend on decree text that the guideline only summarizes. These are flagged `needsVerification`.
7. **X1 location information**: no guideline section. The interview only flags it, and there is no rule pack.

## Assumptions and questions for the user

1. **Contract fit**: `template-v1.json` passes the Row 5 `InterviewTemplateSchema`. Presentation fields live in `template-v1.ux.json`. Open points for the architect: an explicit "always" `Cond` (a tautology is used now), a `may` priority (kept in the sidecar), and a rule-pack Zod schema that accepts pack-level `legalRefs` maps keyed by `LAW:article(paragraph)item` plus the extra pack fields listed in `index.json` `ruleShapeNotes`. No rule-pack contract existed when this was written.
2. **Interview length**: decided 2026-09-30: an intake sheet ships in Phase 1 (`intake-sheet-v1.json`, Korean and CSV versions).
3. **PM seed template (design Q5)**: none was found in the repository. Please provide it so v1 can be reconciled.
4. **Outsourcing vs provision defaults**: decided 2026-09-30: always manual review (flag `ambiguity.delegation_vs_provision`).
5. **Rubric severity**: the guideline says the comparison table (R-S24-004) and the transmitter method (R-S16-005) "must" be given, but the guideline cites no statute for the comparison table. Should they be blocker or major?
6. **HR and location sources**: HR retention decided 2026-09-30 and verified (16 entries). X1 location information is still a manual-review placeholder.
7. **Post-guideline amendments**: decided 2026-09-30: S18 carries Act 21445 rules marked `beyondGuideline`. Act 21445 does not change the mandatory policy items (PIPA 30, Decree 31).
8. **Safety-measures notice number**: resolved 2026-09-30 via the admrul API. 제2025-9호 (2025-10-31) is superseded by 제2026-9호 (in force 2026-07-01). The measure-level diff between them is still open (NV-S11-01).
