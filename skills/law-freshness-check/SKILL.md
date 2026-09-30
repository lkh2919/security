---
name: law-freshness-check
description: >
  Maintains the KB stamps: checks law.go.kr Open API and official PIPC and KFTC pages against manifest.json,
  updates the manifest and keeps the first-run verification list current.
  Use when: refreshing manifest stamps, checking whether PIPA, its Decree or the KFTC standard terms changed,
  or moving an item off the pending-verification list.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: kb-curator
prerequisites: law.go.kr OC key in the operator environment (Q7); kb/jurisdictions/kr/manifest.json; kb/jurisdictions/kr/statutes/
relates_to:
  - skill: freshness
    type: relates_to
  - skill: lotte-corpus-curation
    type: composes_with
metadata:
  type: process
  triggers:
    - law freshness
    - manifest update
    - verification list
    - law.go.kr check
    - amendment check
---

## Overview

Harness-side counterpart of the runtime R6 watcher. Design: R5.1 (verified-source rule), R5.5 (`citations.json` and first-run list), R5.6 (`manifest.json` shape and flow), R12 (unverified law facts risk).

## When to Use

- Monthly refresh, after any rule-pack or clause-library change, and before the freeze on 2026-10-21.
- The two first-run items: the reported PIPA amendment (2026-03, effective 2026-09-11, turnover-based fine up to 10%) and the KFTC e-commerce standard terms number (reported as No. 10023) with its latest revision date. Both are reported claims, `⚠️ Unverified` until checked.

## Prerequisites

- Never store the OC key in files or logs. Use official sources only; do not scrape mirrors or blogs.

## Procedure

1. List sources: PIPA, its Decree, the Standard Guideline, ARTC, the E-Commerce Act and the Network Act (law.go.kr `target`, `id`, `effective`); PIPC guideline page; KFTC standard-terms page.
2. Fetch current version IDs and page title hashes; compare with `manifest.json` (`lawSnapshot`, `pages`).
3. For each change, list affected sections through the `legalRefs` reverse index and notify privacy-domain-expert via PM. Do not edit rules yourself.
4. Verify each item on `pending-verification.json` against an official source. Move an item to `citations.json` only with `{ citationId, law, article, title, effectiveFrom, sourceId, verifiedAt }`; otherwise keep it pending with today's check date.
5. Recompute `rulePacks[{id, version, sha256}]`, `clauseLib`, `houseStyle` stamps and write `manifest.json`.
6. If a source is unreachable, record "freshness unverified" for it; do not guess.

## Output Format

Drift table (source, old stamp, new stamp, affected sections), verification-list changes with URL and `verifiedAt`, updated manifest diff summary, unreachable sources.

## Definition of Done

- Every stamp change has a source URL and date; no unverified fact reached `citations.json`.
- The pending list is current; drift is reported, never hidden.
- No secret written to disk; outputs are drafts pending legal review.
