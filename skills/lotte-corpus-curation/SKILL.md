---
name: lotte-corpus-curation
description: >
  Curates the Lotte clause library: captures public policies, records per-clause provenance, splits and clusters
  clauses, hands candidates to vetting, and extracts house-style candidates.
  Use when: capturing or refreshing Lotte-group public privacy policies and terms, building clause records,
  computing the coverage matrix, or proposing house-style rules.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: kb-curator
prerequisites: Approved site list from PM (design Q1); finance affiliates excluded; kb/jurisdictions/kr/clauses/ and house-style/ directories
relates_to:
  - skill: rulepack-authoring
    type: enables
  - skill: law-freshness-check
    type: composes_with
metadata:
  type: process
  triggers:
    - lotte corpus
    - clause library
    - clause provenance
    - house style extraction
    - capture policies
---

## Overview

Produces `kb/jurisdictions/kr/clauses/{privacy,terms}/`, `provenance.json` and `house-style` candidates. Design: R5.3 (clause record, pipeline, business groups), R5.4 (house style), R8 (benchmark is concepts only).

## When to Use

- Corpus capture and refresh; new business group; house-style extraction.
- Not for legal vetting or approvals (privacy-domain-expert decides).

## Prerequisites

- Public pages only, finance affiliates excluded. Non-public policies are out of scope until design Q2 is answered.

## Procedure

1. Capture each allowed page: HTML snapshot (local, gitignored under `kb/_sources/`), `contentHash`, `captureDate`, `policyEffectiveDate`. Polite rate, robots.txt respected, no login or forms.
2. Split by item (S01-S24, T01-T15) and record a section mapping per clause.
3. Normalize to a clause record: `{ clauseId, docType, itemIds, body, vars, conditions, provenance{sourceUrl, affiliate, businessGroup, captureDate, policyEffectiveDate, contentHash}, vetted:false, vettedAgainst:null, styleRefs }`. `body` is a paraphrased, normalized template with `{{var}}` and `{%if cond%}` blocks; never a bulk verbatim copy.
4. Cluster near-duplicates per item and business group (`retail-commerce`, `fnb-membership`, `hospitality-leisure`, `manufacturing-b2b`, `it-services`, `recruiting-employee`); pick a canonical clause per cluster with reasons.
5. Queue canonical candidates for privacy-domain-expert vetting. Clauses predating the 2026.4 guideline are flagged, not dropped.
6. Extract house-style candidates from Lotte Innovate policies as `H-01...` with `scope`, `kind`, `rule`, `example` (short) and `sourceClauseIds`; submit for approval.
7. Rebuild the coverage matrix (item by business group: vetted clause count); give kb-curator's stamps to `law-freshness-check` for the manifest.

## Output Format

Capture log (URL, date, hash, status), clause counts by item and group, cluster report, vetting queue, house-style candidates, matrix, pages not captured and why.

## Definition of Done

- Every clause has full provenance; none is marked `vetted` by kb-curator.
- No bulk verbatim republishing; snapshots stay local and ignored by git.
- Matrix and manifest stamps updated; open scope questions listed for PM.
