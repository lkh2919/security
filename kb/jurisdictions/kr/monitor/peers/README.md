# Peer registry (C5 Peer Watch)

`peer-registry.json` lists the user-approved peer companies per group, with the official privacy policy URL, render mode and robots result. Provenance only: no page bodies are stored here, and no personal data.

- Peer policies are public under PIPA Art. 30(2). Use is reference only, change detection only; never rate or rank peers.
- `status`: `active` (fetch allowed), `excluded` (robots disallows, see `excludedReason`), `to_verify` (URL not confirmed or robots.txt unreachable, see `toVerifyReason`). All current peers are `active`.
- `excludedHistory`: peers dropped on 2026-10-02 (robots disallow, or URL unconfirmed and robots unreachable), with the reason and `replacedBy`, so each substitution is traceable.
- `render`: `html` (policy text in the server response), `js_required` (needs a JS fallback or manual capture), `pdf`, `unknown`.
- `lotte`: ids from `../../clauses/_captures/index.json` (privacy docType, capture `ok` or `ok_browser_meta`, not robots-excluded). `lotteFetch` marks ids that need a rendered browser fetch (`ok_browser_meta` captures). `lotteNotIncluded` lists privacy captures left out and why (including 롯데지주, a user decision); `unassigned` is empty. In `tour_service`, the Lotte logistics, IT services and recruiting captures were placed there by user decision.
- Checks used the UA `LottePolicyMonitor/0.1`. HTTP 401/403/429/5xx on robots.txt counts as `unreachable` (peer skipped); 404 or 400 counts as no rules. Re-run the checks before any live crawl: sites change robots rules.
