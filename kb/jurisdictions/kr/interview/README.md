# Interview Template v1 (Korea): cover note

Reference draft for the privacy-agent pipeline. Content is paraphrased from PIPC, Privacy Policy Drafting Guideline, 2026.4, and design R4.1-R4.4. Outputs are drafts, not legal advice; InfoSec and legal review are required.

## Files

| File | Purpose |
|------|---------|
| `template-v1.json` | Machine template: 10 modules, 146 question nodes, branch conditions. Validates against the Row 5 `InterviewTemplateSchema` (`packages/core/src/contracts/interview-template.ts`), with no unknown slots against `slots.json`. It is the interviewer script source, the extraction map for R2, and the gap engine for C1. |
| `template-v1.ux.json` | Sidecar keyed by node ID: `example` answer, `optionLabels` (Korean labels for `options`), `estSec`, `prefillable`, `priorityDetail: "may"`, module titles, and the `always` flag. Presentation and timing only; the pipeline may ignore it. |
| `slots.json` | Single slot registry (119 slots; Row 4c added 5 privacy slots and accepted the 13 Row 4b terms slots unchanged), loadable with `slotRegistryFromJson`. Paths follow the R4.3 sketch where one exists (`inR43: true`); the others are proposals. |
| `ko/interview-template-v1.ko.md` | Korean questionnaire for the human interviewer, rendered from the template plus the sidecar (same IDs and order). Regenerate it after template edits. |
| `intake-sheet-v1.json` | Pre-interview intake sheet (user decision 2026-09-30): 12 tables, 92 fields mapped to slot IDs (and table columns), each table listing the nodes it pre-answers with `confirm` (read back, must nodes) or `skip` (should nodes, when filled). Carries `confirmSecByAnswerType` for timing and `derive` notes (for example the ambiguity flag). |
| `ko/intake-sheet-v1.ko.md` | Korean fill-in version for developers: guidance, examples and blank rows per table, 20-30 minutes. Rendered from the JSON. |
| `ko/intake-sheet-v1/*.csv` | One CSV per table (UTF-8 with BOM so Excel shows Korean), header row plus one example row to delete. Form tables list one field per row. |

Rule packs the template maps to: `../rulepacks/privacy-2026.04/` (S01-S24, A1, `index.json`, `coverage-matrix.md`).

## Structure

- **Modules** (interview order): `core` → `b2c_commerce` → `member_community` → `internal_hr` → `marketing` → `ai_feature` → `overseas_transfer` → `children` → `cctv_location` → `terms`. Each module has an `enterIf` condition; `core` and `terms` always run.
- **Node fields (contract)**: `id`, `text` (Korean, one question), `help` (why we ask), `answerType`, optional `options` (stable codes), `targets` (slot paths), `itemRefs` (S01-S24, A1, X1, T01-T15), optional `showIf`, `priority`, and `evidenceHint` (what the extractor listens for). The sidecar adds the `example` answer, the Korean `optionLabels`, `estSec`, `prefillable`, and `priorityDetail`.
- **Priority**: `must` is always asked. Every mandatory (M) privacy item and every conditional (C) item has at least one `must` node, and each C item has a gate node that decides applicability. `should` is asked when time allows. Two nodes (`Q-S03-07`, `Q-S23-57`) are optional (`priorityDetail: "may"` in the sidecar) and carry `should` in the template because the contract allows only `must` or `should`.
- **Always-on modules**: `core` and `terms` use a tautology `enterIf` (`profile.serviceTypes` exists OR not exists), because the contract `Cond` requires a non-empty `all` or `any`. The sidecar marks them `always: true`.

## Node ID scheme

`Q-<item>-<nn>`. `<item>` is `P` (profile), `S01`-`S24`, `A1` (gen-AI), `X1` (location), or `T01`-`T15` (terms). `<nn>` shows the module: 01-19 core, 20-29 b2c_commerce, 30-39 member_community, 40-49 internal_hr, 50-59 ai_feature, 60-69 marketing, 70-79 overseas_transfer, 80-89 children, 90-99 cctv_location. The terms module numbers 01-19 in sequence. IDs are stable and never reused; `Q-S03-02` is retired because it was merged into `Q-S03-01`.

## Branching

- `Cond` follows R4.4: `all`, `any`, `not`, and `{slot, op, value}` with `eq`, `in`, `exists`, `truthy`. On a multi-value slot, `in` means any overlap. This semantics is assumed; the evaluator is Row 5 work.
- Gate questions in `core` (for example `Q-S07-01`, `Q-S10-01`, `Q-A1-01`) set `gate.*` slots. Those slots open detail nodes and later modules.
- Service type (`Q-P-02`) opens `b2c_commerce`, `member_community` or `internal_hr`. Member accounts (`Q-P-05`) also open `member_community`.
- `Q-S09-05` and `Q-S09-06` implement the user decision of 2026-09-30: PG, marketplace sellers, external LLM/API vendors and plug-ins/SDKs raise flag `ambiguity.delegation_vs_provision` (defined in `../rulepacks/privacy-2026.04/S09.json` `flags`). The draft shows both candidate treatments and a Korean reviewer message; nothing is chosen silently. `Q-A1-54` answers also raise the flag.
- A later module can reopen earlier core nodes. `Q-S07-60` (marketing sharing) can set `gate.thirdPartyProvision`, and `Q-A1-54` (external AI model) can set `gate.outsourcing` and `gate.overseasTransfer`. When that happens, go back and ask `Q-S07-02` and `Q-S07-03`, or `Q-S09-02` to `Q-S09-04`. The overseas module runs after the AI module for this reason.
- `cctv_location`, `A1` and `X1` are warn-only: answers produce manual-review placeholders, not final clauses.

## Running the mp3 interview

1. Before the session, send `ko/intake-sheet-v1.ko.md` (or the CSVs). Pre-answered `must` nodes are only read back and confirmed; pre-answered `should` nodes are skipped when filled. Empty or '모름' fields are asked as usual.
2. At the start, the speaker states the service name(s) and the operating company, then says which service types apply.
3. For each task, the speaker covers the purpose, the data items (required or optional), the legal basis (consent, contract, or statute with article), and the retention.
4. The speaker names every vendor and recipient, and says whether each one works on our behalf (outsourcing) or for its own purpose (provision). The speaker also names server or vendor countries for any overseas transfer.
5. The speaker covers cookies, SDKs, ad IDs and third-party pixels; users under 14; AI features and training use; automated decisions; CCTV or mobile cameras; and location data.
6. For the privacy officer and departments, the speaker gives **titles and departments only**. No personal names, private phone numbers or personal e-mail addresses go on the recording; contacts are filled in after the run.
7. Read the question ID aloud before each answer. Answer "모름" (unknown) instead of guessing. Unknown answers become `needs_manual_review`.

**Time budget** (typical B2C with members, marketing, cookies, vendors including a PG, and physical goods; no overseas, AI, children or CCTV): about 33 minutes for `must` nodes with the intake sheet and about 48 minutes with `should` nodes; about 60 minutes if everything is dictated. Row 4c added must nodes (ambiguity follow-up, terms facts), so the old sidecar-only prefill estimate is now about 42 minutes. All read-back costs are heuristics.

## Known limitations

- **Contract fit**: `template-v1.json` passes the current Row 5 schema. Two items still need a decision. The contract has no explicit "always" condition, so a tautology is used. `may` has no contract value, so it lives in the sidecar. If Row 5 adds either one, fold it back into the template.
- **Terms**: nodes cover the T01-T15 topics. Row 4c added 11 terms nodes (`Q-T01-20` to `Q-T15-31`) for the Row 4b slots; `terms.withdrawalRestrictedGoods` is filled by `Q-T10-12`. Columns for `terms.deliveryPolicy` and `terms.withdrawalRestrictedGoods` were set from the Row 4b descriptions. The help text makes no statutory claims about notice periods or refunds.
- **Slot paths**: `slots.json` paths are proposals. The `gate.*` slots are proposed as R4.3 `applicability.basisSlots`, and the fact-ledger contract must align with them.
- **No PM seed template**: none was found in the repository (design Q5). v1 is built from the guideline and must be reconciled with the seed when it arrives.
- **Legal gaps**: HR retention periods are now verified for 16 record types (`../statutes/retention-periods.json`, via `Q-S05-41`). Location information (X1) and other legal bases outside the guideline still have no verified source; nodes flag them for legal review.
- **Coverage test**: currently a one-off validation script run by privacy-domain-expert (0 errors on 2026-09-29 and 2026-09-30, including the Row 5 Zod parse and the intake-sheet cross-checks). Row 5 should port it to a repo test: every M item has a `must` node, every target and condition slot exists, and every pack's `interviewNodes` exist.
- **Time estimates**: heuristic per-answer-type values, not measured. Calibrate them after the first pilot interviews.
