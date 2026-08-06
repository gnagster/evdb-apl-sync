# APL Low-Confidence Review Agent

Daily OpenChamber task against the repo. Gives low-confidence EVDB→APL mappings the final
human look and persists decisions as manual overrides. Runs in the repo root
`/home/luis/stacks/evdb` (origin `gnagster/evdb-apl-sync`).

## Context

- `apl-prices.json` is regenerated nightly by a GitHub Action (05:10 UTC).
  Each `Make|Model` entry has `{slug, confidence 0..1, endpreis, …, offers:[{tag,endpreis,…}]}`.
  Matches below 0.85 are listed in top-level `lowConfidence[]`; exactly 0.85 are borderline.
- Per-variant pricing: when an evdb model name carries a trim the APL modellvarianten page
  names (`matcher.matchVariant`, e.g. "Taycan Turbo S", "EV9 … GT-Line", "ID.Buzz Pure"),
  the pipeline scrapes that variant line's price instead of the base/cheapest price of the
  slug. Models naming no trim (base, battery-numbered "Enyaq 85", powertrain-only
  "EX40 Single Motor") fall back to the battery-rank/base price. So `endpreis` is per
  identifiable trim, not always the cheapest on the page.
- `tools/overrides.json` (agent-owned): `{"Make|Model": "apl-slug" | null}`.
  The pipeline merges it: slug redirects which APL vehicle is scraped (confidence → 1.0),
  null force-skips the entry (explicit unmatched). Never guess. Overrides redirect the slug;
  per-variant pricing still applies inside the redirected slug.
- `tools/review-ledger.json` (agent-owned): `{"Make|Model": {date, confidence, decision, reasoning}}`
  — prevents re-reviewing unchanged entries.
- Reference data: `test/fixtures/evdb-bestellbar.json` (evdb side:
  id, make, model, shape, range_km), `tools/apl-sitemap.json` (APL slugs).
- Live lookups: APL modellvarianten/detail pages (detail blocks carry `data-sortkw`,
  `data-sortmotor` like `81,4 kWh`, `data-sortgrundpreis`) and ev-database.org detail pages
  `/car/{id}/{Name}` (no trailing slash; "Total Power" row has kW). Accept a mapping only if
  battery kWh and motor kW are consistent (kWh within 15% or 5 kWh absolute; kW within 25%
  or 30 kW absolute).

## Workflow

1. Read `apl-prices.json`. Review set = keys in `lowConfidence[]` plus keys with confidence
   exactly 0.85. If the review set is empty, or every key is already in the ledger with the
   same confidence → reply with exactly `No new low-confidence entries` and change nothing.
2. For each new/changed key: identify the evdb model and the APL candidate, verify spec
   consistency as above. Because the pipeline prices per identifiable trim, check whether the
   evdb model names a trim the APL page lists — if yes, the endpreis will be that trim's, so
   confirm the trim (not just the family) is the right one. Decide: correct → no override
   (ledger only); wrong but identifiable → override with the right slug; unresolvable →
   override `null` with reasoning. Log every decision in the ledger (date, confidence,
   decision, one-line reasoning). Preserve other keys when merging; keep JSON pretty-printed
   and sorted.
3. Validate: run `node test/matcher.test.js` (must stay green — it does not
   read overrides) and JSON-parse both tools files. If `overrides.json` contains a slug the
   pipeline can't find in `apl-sitemap.json`, drop it and note why.
4. If anything changed: `git add tools/overrides.json
   tools/review-ledger.json`, commit `APL review: <n> low-confidence mappings
   finalized`, then `git pull --rebase && git push`. If nothing changed, no commit, no push.

## Rules

- `null` means deliberate skip, never lazy — always write the reasoning.
- Never overwrite an existing override without updating its ledger entry.
- Skip entries whose payload lacks an `offers` array (old JSON shape).
- If an entry can't be resolved confidently, record it as `unresolved` and move on.
- Keep the whole task under ~25 tool calls.
- Only touch the two `tools/*.json` files. Never modify matcher.js, scraper.js, content.js,
  background.js, manifest.json, or test fixtures.
