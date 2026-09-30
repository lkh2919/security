# Contracts (design R4)

Zod schemas for every data contract in the pipeline. One file per family; `index.ts` re-exports all.
Every object is `z.strictObject`: unknown keys are rejected, never stripped.

## Files

| File | Contracts |
|------|-----------|
| `common.ts` | IDs, `SlotRegistry`, `Cond`, `Warning`, `ContractError` / `parseContract` |
| `form-slots.ts` | `FormSlots` |
| `masked-transcript.ts` | `MaskedTranscript` (segment IDs `T0001`) |
| `pii-vault.ts` | `PiiVault` (local only), `findVaultLeaks`, `rehydrate` |
| `fact-ledger.ts` | `FactLedger`, `Evidence`, `verifyTranscriptEvidence` |
| `applicability.ts` | `ApplicabilityMap` |
| `gap-list.ts`, `question-set.ts` | `GapList`, `QuestionSet`, `AnswerSet` |
| `clause-selection.ts` | `ClauseRecord`, `ClauseSelection` |
| `interview-template.ts` | `InterviewTemplate` |
| `ast.ts` | `PolicyAST`, `TermsAST`, `SectionAST`, walkers |
| `audit-report.ts`, `check-results.ts` | `Finding`, `AuditReport`, `CheckResults` |
| `audit-envelope.ts` | `AuditEnvelope` (auditor allowlist) |
| `freshness-report.ts`, `manifest.ts` | `FreshnessReport`, `Manifest`, `VersionStamps` |
| `run-state.ts` | `RunState`, pipeline stage list |

## Decisions where R4 was a sketch

1. **Slot IDs are a registry, not an enum.** `SlotId` is a string with the shape `group.name`
   (`gate.membership`, `privacy.S02_purposes`). Valid IDs come from a runtime `SlotRegistry`
   (`createSlotRegistry`, or `slotRegistryFromJson` for `kb/jurisdictions/kr/interview/slots.json`).
   Schemas check the shape; `createFactLedgerSchema(registry)` and `templateUnknownSlots` check membership.
2. **Flat ledger.** R4.3 sketched a nested, hand-typed ledger. `FactLedger.slots` is a flat
   `Record<SlotId, SlotEntry>`. `profile` and `applicability` moved out: profile fields are ordinary
   `profile.*` slots, and applicability is its own `ApplicabilityMap` contract (C1 output).
3. **Evidence is a union.** Transcript evidence carries `segmentId` (C2 checks the segment exists and
   contains the quote). Form, interview, `kb_default` and `user_confirmed` evidence carry a free `ref`.
   A `filled` slot needs a non-null value and at least one evidence item. `missing` and `not_applicable`
   slots must be `null`.
4. **AuditEnvelope isolation is structural.** The envelope is strict and has exactly the twelve keys of
   R6.3. It has no field for drafter prompts, thinking, or `ClauseSelection.rationale`. Tests assert the
   key list, reject extra keys at top level and nested, and scan the JSON Schema for forbidden field names.
5. **PiiVault is never part of an LLM-facing type.** No other contract imports `pii-vault.ts`.
   `findVaultLeaks` is the runtime backstop, used by every `LlmClient` before a call.
6. **One AST schema per docType.** `PolicyASTSchema` and `TermsASTSchema` share a factory. Privacy
   sections must use `S..`, `A1`, `X1`; terms sections `T..`. `trace.citationIds` was added to the R4.5
   section trace so C2 can cross-check inline `cite` nodes.
7. **Profile and scores.** `AuditReport.profile` is `privacy | terms` (R4.5 said `string`). Scores are 0-5.
   `verdict: pass` is rejected when a blocker or major finding exists.
8. **RunState.** Stages follow the R7 state machine (`PIPELINE_STAGES`). Repeated stages overwrite the
   record and use an artifact variant suffix (`10-audit.privacy.i2.json`).
9. **Manifest.** `clauseLib.sites` is a list of URLs. `VersionStamps` is the per-run subset stored in
   `RunState` and used in stage-cache keys.
10. **Interview Template module IDs are strings**, not the closed R4.4 enum, because the module list is
    template content. Question IDs must match `Q-<item>-<nn>`.

## Adding a contract

Define the schema next to its type (`type T = z.infer<typeof TSchema>`), keep it strict, export it from
`index.ts`, and add valid and invalid fixtures to `packages/core/test/contracts.test.ts`.
