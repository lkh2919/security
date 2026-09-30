# Privacy Agent — Project Agents

Dev-time (harness) agents that build, audit and govern the privacy-agent product. PM dispatches; no direct specialist invocation.

**Design reference**: `docs/designs/2026-09-29-privacy-policy-agent-team-design.md` (R3 runtime roster, R9 harness team and skills)

## Runtime agents vs harness agents

| | Runtime agents | Harness agents |
|-|----------------|----------------|
| What | Pipeline stages of the product: O0, R1-R8, C1, C2 | Claude Code agents used to build the product |
| Where | Product code: `packages/core/src/stages/` plus prompt files in `packages/core/prompts/` | `agents/*.md` (this roster) |
| Models | Pinned in `packages/core/src/llm/models.ts` (Haiku extracts, Sonnet drafts, Opus audits) | Alias set per dispatch (`haiku`, `sonnet`, `opus`) |
| Governed by | Product gates: `tsc --noEmit`, unit tests, golden-set regression | Harness rules: this file, `CLAUDE.md`, PM Gateway |

Runtime agents are never `agents/*.md` files.

## Harness Roster

| Agent | File | Tier / alias | Role | Owned skills |
|-------|------|--------------|------|--------------|
| pm | `agents/pm.md` | Medium floor (session model) | Triage, plans, gates, decision records | `privacy-docs`, `interview`, `draft`, `audit`, `freshness` |
| architect | `agents/architect.md` | High / `opus` | Design and contract reviews | `zod-contract-gate` (L0, owner architect) |
| automation-engineer | `agents/automation-engineer.md` | Low / `haiku`; `sonnet` for core LLM modules (Q8) | Code, tests, CLI, adapters, renderer | none (executes plans) |
| auditor | `agents/auditor.md` | Medium / `sonnet` | Harness QA gate, golden-set regression owner | `golden-set-regression` |
| security-expert | `agents/security-expert.md` | Medium / `sonnet` | Masking review, data-flow threat model, key handling | `pii-masking-review`; uses `security-scan` (L0, owner pm) |
| docs-writer | `agents/docs-writer.md` | Medium / `sonnet` | README, operator guide, PPTX outline | uses `documentation-writing` (L0, owner pm) |
| **privacy-domain-expert** (hired) | `agents/privacy-domain-expert.md` | High / `opus` | Rule packs, rubric, Interview Template content, clause vetting, house-style approval, golden references | `rulepack-authoring`, `interview-template-authoring`, `policy-audit-rubric` |
| **kb-curator** (hired) | `agents/kb-curator.md` | Medium / `sonnet` (bulk normalization may use `haiku`) | Corpus capture of public Lotte-group pages, provenance, clustering, house-style candidates, manifest stamps, verification list | `lotte-corpus-curation`, `law-freshness-check` |

`research-analysis` (L0, owner pm) is shared and used by PM, privacy-domain-expert and kb-curator for source research.

**Copies of L0 agents** (pm, architect, automation-engineer, auditor, security-expert, docs-writer) carry `origin: L0` and a "Project scope (privacy-agent)" section at the top of the body. Where that section conflicts with the L0 text, it wins.

## Tier rationale

- **privacy-domain-expert (High)**: the main product risk is legal error; guideline interpretation, rule slicing and clause vetting need the strongest reasoning.
- **kb-curator (Medium)**: grouping and provenance judgment; bulk normalization can drop to `haiku`.
- Tier changes: update the agent frontmatter `tier:` block and this table together.

## Rules

- PM dispatches every specialist with an explicit `model` alias; no direct specialist invocation.
- Git is the project repository only. `/sync` is not used here; PM verifies with the project QA gate (`bun run typecheck`, `bun test`, golden-set regression, `security-scan`) and the user decides on commits. No `--no-verify`.
- Law facts enter rules only with a verified source URL and date (design R5.1). Outputs are reference drafts, not legal advice.
- Markdown files in this project are English-only.

## Skills

See `skills/README.md`. Project skills live in `skills/<name>/SKILL.md`.

## Escalation

If a specialist hits an issue outside its scope (architecture, cross-project infrastructure), it reports to PM, who escalates to architect or the user.
