---
name: rulepack-authoring
description: >
  Slices the PIPC privacy guideline and KFTC-based terms sources into small per-section rule-pack files
  with verified legal references.
  Use when: creating or revising rule packs for privacy S01-S24 (plus the gen-AI appendix A1) or terms T01-T15,
  bumping a rule-pack version, or mapping an amendment to affected rules.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: privacy-domain-expert
prerequisites: Guideline extraction at kb/_sources/pipc-guideline-2026-04.txt; access to official law.go.kr, PIPC and KFTC pages; kb/jurisdictions/kr/statutes/
relates_to:
  - skill: policy-audit-rubric
    type: enables
  - skill: interview-template-authoring
    type: composes_with
metadata:
  type: domain
  triggers:
    - rule pack
    - rulepack authoring
    - author rules
    - slice guideline
    - legalRefs
---

## Overview

Produces `kb/jurisdictions/kr/rulepacks/`. Design: R4.1 (privacy catalog and guide line ranges), R4.2 (terms catalog), R5.1 (principles), R5.2 (rule shape and slicing).

## When to Use

- New or changed section rules; new amendment verified by kb-curator.
- Not for clause text (`lotte-corpus-curation`) or rubric scoring (`policy-audit-rubric`).

## Prerequisites

- Read the pending list `kb/jurisdictions/kr/statutes/pending-verification.json` first. Items on it may not become rules.

## Procedure

1. Pick one section (for example `S05`). Read only its line range from the guideline extraction (R4.1 table) or its KFTC standard-terms article.
2. Write one file per section: `S01.json` ... `S24.json`, `A1.json`, `T01.json` ... `T15.json`; shared files `principles.json`, `glossary.json`, `unfair-clause-lexicon.json`.
3. Rule shape: `{ ruleId, sectionId, level: must|should|may, statement, legalRefs[{law, article, paragraph, item}], check: {kind: deterministic|llm, expr?}, sourceSpan, verifiedAt }`. Paraphrase; attribute ("PIPC, Privacy Policy Drafting Guideline, 2026.4"); short quotes need a source line and line range.
4. Verify every `legalRefs` entry against law.go.kr or an official PIPC or KFTC page and record the URL and `verifiedAt`. Unverifiable items go to `pending-verification.json`, marked `⚠️ Unverified`.
5. Prefer `deterministic` checks (regex, presence, table-shape) so C2 costs zero tokens; use `llm` only where judgment is required.
6. Keep each file about 1-3K tokens. Regenerate the `legalRefs` reverse index (`law+article -> sections`) and hand the new sha256 and version to kb-curator for `manifest.json`.
7. Add or update a test fixture proving each `must` rule is checkable, then request the regression gate from auditor.

## Output Format

Changed rule-pack files, version bump note, source table (URL, `verifiedAt`), list of items sent to the pending list.

## Definition of Done

- Every rule has `sourceSpan` and `verifiedAt`; no unverified law fact appears in any rule.
- Every M item of the catalog has at least one `must` rule.
- Files validate against the rule schema (Zod, design Row 5) and stay within the slice size.
- Outputs remain drafts for legal review, never legal advice.
