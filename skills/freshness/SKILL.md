---
name: freshness
description: >
  Runs the law and guideline freshness check for a run: compares version stamps in the manifest with
  law.go.kr and official PIPC and KFTC pages, and reports drift per affected section.
  Use when: starting a run, before a release, or when asked whether the rules and clauses are still current.
version: 1.0.0
last_reviewed: 2026-09-29
status: active
scope: project
owner: pm
prerequisites: Bun runtime; privacy-agent CLI (planned); law.go.kr OC key held by the operator; kb/jurisdictions/kr/manifest.json
relates_to:
  - skill: law-freshness-check
    type: relates_to
metadata:
  type: process
  triggers:
    - freshness
    - law drift
    - law changed
    - check amendments
    - freshness report
---

## Overview

Sub-skill of `privacy-docs`. Maps to the planned CLI subcommand `privacy-agent freshness`.
Design: R5.5 (verification list), R5.6 (stamps and flow), R3 (R6 watcher), R7 (runs in parallel with intake).
Harness-side maintenance of the manifest and list is `law-freshness-check` (kb-curator).

## When to Use

- Per run (cached 24 hours), or on demand.
- Not for updating rules after a change (that goes to privacy-domain-expert through PM).

## Prerequisites

- CLI status: PLANNED (design R15 row 12). Until built, `law-freshness-check` performs the same steps by hand.
- The OC key is supplied through the environment by the operator; never write it to a file or log.

## Procedure

1. Read `manifest.json` stamps: `rulePacks`, `lawSnapshot`, `clauseLib`, `houseStyle`, `pages`.
2. Query law.go.kr for PIPA, its Decree, the Standard Guideline, ARTC, the E-Commerce Act and the Network Act; compare version IDs.
3. For a changed law, map changed articles to sections through the `legalRefs` reverse index (code); the LLM (Haiku) writes only a short summary.
4. Check the PIPC guideline page and the KFTC standard-terms page by title hash.
5. Run the first-run verification list; items stay out of rules until verified.
6. Attach a `freshness` note per affected section. If all sources fail, report "freshness unverified".

## Output Format

`FreshnessReport`: per source (id, old stamp, new stamp, changed articles), affected section IDs, watermark flag, verification-list status, and the failure mode used.

## Definition of Done

- Drift never blocks drafting; it produces notes, watermark and a Reviewer Sheet entry.
- No key or personal data in logs or artifacts.
- The report states which sources were reached and which failed.
