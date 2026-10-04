# Project Skills

Skills for the privacy-agent harness, one folder each with a `SKILL.md`. Owners follow design R9 (`docs/designs/2026-09-29-privacy-policy-agent-team-design.md`).

## Project skills

| Skill | Owner | Purpose |
|-------|-------|---------|
| `privacy-docs` (router) | pm | Routes to `interview`, `draft`, `audit`, `freshness`; entry points are the scripts in `scripts/` (`run-pipeline`, `freshness-check`, `golden-regression`) |
| `privacy-monitor` | pm | Runs `check`, `impact`, `daily`, `peers` for an org config with `--llm claude-code` (HUB skill; `docs/adopt-in-30-minutes.md`) |
| `interview` | pm | Intake, masking, extraction, coverage, gap questions, interviewer script |
| `draft` | pm | Clause-first drafting of policy and terms, checks, rendering |
| `audit` | pm | C2 checks, isolated auditor, capped fix loop |
| `freshness` | pm | Law and guideline drift report for a run |
| `rulepack-authoring` | privacy-domain-expert | Slice guideline and terms sources into rule files with verified `legalRefs` |
| `interview-template-authoring` | privacy-domain-expert | Modules, nodes, `evidenceHint`s, coverage test |
| `policy-audit-rubric` | privacy-domain-expert | Shared layer, profiles, seeded defects |
| `lotte-corpus-curation` | kb-curator | Capture, provenance, clustering, vetting handoff, house-style extraction |
| `law-freshness-check` | kb-curator | Law and page checks, manifest update, verification list |
| `golden-set-regression` | auditor | Batch runs, metrics, thresholds |
| `pii-masking-review` | security-expert | Pattern coverage and leak tests |

## Reused from L0 (`origin: L0`, unchanged except the metadata note)

`zod-contract-gate`, `security-scan`, `research-analysis`, `documentation-writing`.

## Conventions

- Frontmatter: `name` (= folder), `description` ("Use when: ..."), `version`, `last_reviewed`, `status`, `scope: project`, `owner`, `prerequisites`, `relates_to` (typed), `metadata.type` and `metadata.triggers`.
- Each skill stays short and points to design sections and concrete paths (`kb/jurisdictions/kr/...`, `packages/core/...`, `golden/...`).
- Sub-skills are separate top-level folders (no nesting) so each is callable alone.
- Owner changes go through PM and are mirrored in `../AGENTS.md`.
