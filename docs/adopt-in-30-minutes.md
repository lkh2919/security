# Adopt in 30 minutes

A new affiliate or department adopts the Privacy Monitor with data only: one config file, a folder of its published policies, and an optional peer list. No code changes. Korean version: [`ko/adopt-in-30-minutes.md`](ko/adopt-in-30-minutes.md).

All output is a reference review ("참고용 검토 결과입니다. 정보보호실·법무 검토가 필요합니다."). It is not legal advice.

## 0. Prerequisites (5 min)

- Bun, then `bun install`.
- A model backend, or none:
  - Claude Code login: pass `--llm claude-code` (no API key needed).
  - Or `ANTHROPIC_API_KEY` in `.env` and `--llm api`.
  - Or `--llm none`: deterministic checks only (the report says so).
- Optional `LAW_GO_KR_OC` (law.go.kr key, bound to a registered IP) for law freshness in `daily` and for `peer-history`. Without it `daily` skips the freshness step.

## 1. Create the org config (5 min)

Copy `config/orgs/example/org.json` to `config/orgs/<org>/org.json`:

```json
{
  "name": "Example Retail Co. (placeholder)",
  "tenantId": "example",
  "domainGroup": "retail-example",
  "policyDir": "watch/example",
  "reviewers": ["infosec-reviewer-1", "legal-reviewer-1"],
  "apps": ["check", "impact", "peers", "draft"],
  "llm": "none",
  "rulePacks": ["privacy-2026.04"],
  "peersFile": "../../../kb/jurisdictions/kr/monitor/peers/peer-registry.json"
}
```

| Field | Meaning |
|-------|---------|
| `tenantId` | 1-32 chars of `[a-z0-9-]`; prefixes every output path |
| `domainGroup` | peer group (used as the default for `peers`) |
| `policyDir` | folder of your policies, relative to the repo root unless absolute |
| `reviewers` | role labels only, never names or contacts |
| `apps` | enabled subcommands: `check`, `impact`, `peers`, `draft`. `daily` needs `check` or `impact` |
| `llm` | default backend `api`, `claude-code` or `none`; `--llm` overrides it |
| `rulePacks` | ids under `kb/jurisdictions/kr/rulepacks/`; the first also drives the deterministic checks |
| `peersFile` | optional peer registry, path relative to the config folder |

Keep secrets and personal data out of this file.

## 2. Add your policies (5 min)

Put published policy files (`.md`, `.html`, `.htm`) in `policyDir`. `.docx` and `.pdf` are not read yet and are reported as "manual review required". `watch/` is gitignored; do not commit policies you do not own.

## 3. Optional peer list (2 min)

Point `peersFile` at a registry JSON for your group (the shared one is `kb/jurisdictions/kr/monitor/peers/peer-registry.json`; its README explains the entry format). Peers are reference only.

## 4. Run (10 min)

```bash
# Mode A: does each policy meet the rule packs in force? (unchanged policies are skipped; --force re-checks)
bun scripts/agent.ts check  --config config/orgs/<org>/org.json --llm claude-code [--force]

# Mode B: which sections does an amendment affect? (old and new law XML, law code)
bun scripts/agent.ts impact --config config/orgs/<org>/org.json --diff old.xml,new.xml --law PIPA [--effective YYYY-MM-DD] --llm claude-code

# Daily chain: freshness (needs LAW_GO_KR_OC), checks, impact, peers; resumable
bun scripts/agent.ts daily  --config config/orgs/<org>/org.json --llm claude-code [--run-id daily-YYYYMMDD] [--skip-peers]

# Peer Watch: change detection on peer policies
bun scripts/agent.ts peers  --config config/orgs/<org>/org.json [--group <id>] [--dry-run] [--limit N] [--with-lotte]

# Historical peer comparison across an amendment (needs LAW_GO_KR_OC)
bun scripts/peer-history.ts --config config/orgs/<org>/org.json [--group <id>] [--law PIPA --old-mst <mst> --new-mst <mst>] [--effective YYYY-MM-DD] [--since YYYY-MM-DD]

# Draft a new policy from an interview (needs a model backend)
bun scripts/agent.ts draft  --config config/orgs/<org>/org.json --transcript interview.txt --form form.md [--masking basic] [--run-id ID] [--effective-date YYYY-MM-DD] --llm claude-code
```

`peers --export-baselines` is a migration helper and fetches nothing. Peer fetching obeys robots.txt and one page per host per UTC day.

## 5. Where outputs go

Everything is written under `runs/<tenantId>/`, which is gitignored. Never commit run outputs.

| Command | Output |
|---------|--------|
| `check`, `impact` | `runs/<tenantId>/monitor/<stamp>/` (`<policyId>.md|json`, `summary.md`, `usage.jsonl`), registry in `monitor/registry.json` |
| `daily` | `runs/<tenantId>/daily/<runId>/` (digest, step outputs, `usage.jsonl`) |
| `peers`, `peer-history` | `runs/<tenantId>/peers/` (snapshots, change log, reports, `history-<law>-<date>.md|json`) |
| `draft` | `runs/<tenantId>/draft/<runId>/` |

## 6. Read the report

- **Severity**: `critical`, `high`, `medium`, `low`, `confirm`. Sorted most severe first.
- **Provisional vs confirmed**: `confirmed` findings come from reviewed rule packs. `provisional` findings are automatic amendment-impact guesses; they are labelled unverified and never above Medium.
- **Confirm questions**: where the published text cannot prove a requirement (fact-dependent rules, an unlocated section, an unreadable file) the report asks a question instead of asserting a violation. Answer them with the people who know the service.
- **Finance**: a paragraph that matches the finance lexicon yields "금융 법령 해당 – 수동 검토". It is never sent to a model and gets no suggested wording. Finance is reviewed by people only; the tool is monitoring-only there.
- **Peer signals** are industry reference ("peers changed", "peers aligned", group adoption). They are not a legal requirement. There is no rating or ranking of peers.

## 7. Limits

- Reference only, not legal advice. InfoSec and legal review is required before any change.
- Reads `.md`, `.html`, `.htm`; DOCX and PDF input are not supported yet.
- Finance policies: monitoring and manual review only.
- Law freshness and `peer-history` need `LAW_GO_KR_OC` on the registered IP.
- `draft` output is a reference draft; see the [operator guide](operator-guide.md) section 3-4.

## Library API

Use `packages/core` directly (no server dependency): `runMonitorFolder` (check and impact), `runDaily`, `watchPeers`, `startRun` (draft pipeline) and `draftDocument`, all exported from `packages/core/src/index.ts`. `scripts/agent.ts` is the reference wiring.

## Claude Code skill

`skills/privacy-monitor/SKILL.md` runs these commands with `--llm claude-code`. HUB card: [`hub/agent-card.md`](hub/agent-card.md).
