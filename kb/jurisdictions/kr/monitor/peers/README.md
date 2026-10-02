# Peer registry (C5 Peer Watch)

`peer-registry.json` lists the user-approved peer companies (2026-10-02) per group, with the official privacy policy URL, render mode and robots result. Provenance only: no page bodies are stored here, and no personal data.

- Peer policies are public under PIPA Art. 30(2). Use is reference only, change detection only; never rate or rank peers.
- `status`: `active` (fetch allowed), `excluded` (robots disallows, see `excludedReason`), `to_verify` (URL not confirmed or robots.txt unreachable, see `toVerifyReason`).
- `render`: `html` (policy text in the server response), `js_required` (needs a JS fallback or manual capture), `pdf`, `unknown`.
- `lotte`: ids from `../../clauses/_captures/index.json` (privacy docType, capture `ok` or `ok_browser_meta`, not robots-excluded). `unassigned` holds Lotte captures with no group yet (user decides); `lotteNotIncluded` lists privacy captures left out and why.
- Checks used the UA `LottePolicyMonitor/0.1`. HTTP 401/403/429/5xx on robots.txt counts as `unreachable` (peer skipped); 404 counts as no rules. Re-run the checks before any live crawl: sites change robots rules.
