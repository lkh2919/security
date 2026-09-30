# Statutes (kr)

Law targets, citations, and the first-run verification list for the Korean jurisdiction.

## law.go.kr Open API access

- The freshness watcher (R6) and the `law-freshness-check` skill read the key from the environment variable `LAW_GO_KR_OC`. Copy `.env.example` to `.env` and set it there. `.env` is git-ignored; never write the key into JSON, logs, reports, or code.
- The OC key is bound to the IP address or domain registered at approval time. Calls from another machine or network can fail even with a valid key, so Phase 1 runs the watcher only from the registered machine.
- Error responses (for example an unregistered or unapproved OC) return **HTTP 200** with an error message in the body. Always parse the body (XML or JSON) and treat a missing expected root element as a failure; never rely on the status code alone.
- Non-ASCII query parameters must be sent as UTF-8 percent-encoded values. Git Bash on Windows garbles Korean characters passed as CLI arguments, so use a `.ts` script run with `bun` instead of hand-typed `curl` arguments.
- Old ftc.go.kr URLs can return a 200 homepage; detect this by content (title hash), not by status.

## Files

- `law-targets.json`: laws and administrative rules the watcher tracks.
- `pending-verification.json`: reported law facts that stay out of rules until verified against an official source.
- `retention-periods.json`: statutory retention periods verified on law.go.kr (Row 4c, 2026-09-30): `{id, group, statute, article, citationId, recordType, period, startsFrom, appliesIf, verifiedBy: [{url, fetched, version}], caveat}`. S05 `statuteHints` and interview node `Q-S05-41` point here.
- `verification-log-2026-09-30.json`: law facts verified in Row 4c (Act 21445 policy impact, Act 21910 28-12(5), safety-measures notice number, HR retention) with sources and the items still unverified.
- `citations.json` (created when items are verified): `{ citationId, law, article, title, effectiveFrom, sourceId, verifiedAt }`.
