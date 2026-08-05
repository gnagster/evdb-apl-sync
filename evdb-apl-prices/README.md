# APL Preise

Chrome MV3 extension that replaces EV-Database (ev-database.org / .de) DE starting
prices with current APL.de prices for orderable ("Bestellbar") EVs, recalculates
Price/Range and refreshes jplist sorting.

## Install (dev)

1. Open `chrome://extensions`, enable "Developer mode".
2. "Load unpacked" → this directory.
3. Open the popup, pick a price source (Privatkunden / Geschäftskunden) and hit
   "Jetzt aktualisieren".

## How it works

- `background.js` (service worker):
  - Fetches the APL sitemap and the ev-database homepage once, extracts the 648
    "Bestellbar" vehicles and 529 APL model slugs, then builds the evdb→APL
    mapping with `matcher.js` (~72% auto-matched; the rest need manual overrides
    via the popup).
  - Resolves each mapped slug to its numeric APL VarianteID (scraped from the
    modellvarianten page; first `data-id` = base variant).
  - Scrapes prices via `POST https://www.apl.de/sys/preisliste/getPreisliste.php`
    (`VarianteID=…&Bonus=&Site=Preisliste`, browser UA required — no UA gets 429).
    GK/PK are classified by the German label text in `scraper.js`, not by the
    numeric `data-tarif` attribute (it varies per variant — verified live:
    Abarth 159/69/71, Kia EV3 117/174/119/118/194/212/120, VW 48/51/52).
  - Caches prices in `chrome.storage.local` for 24 h; hourly alarm refetches
    stale entries. Concurrency 4, 200 ms delay, 429 → retry once.
- `scraper.js`: pure APL scrape core — `fetchPrices(varianteId, mode)` POSTs the
  price API and `parsePrices()` picks the Geschäftskunden block (`Gewerbetreibende|Selbständige`)
  or Privatkunden block (plain "Abholung beim" deal, excluding
  `Preis nur für|vorab zugelassen|Abrufschein|Corporate Benefits|Beamte|GdB`).
- `content.js`: replaces `.price_buy.current .country_de` with the cached APL
  price, updates the hidden `.pricesort`/`.pricefilter`/`.priceperrange` numerics
  jplist reads fresh, and triggers a jplist refresh so sorting/filtering use the
  new prices.
- `popup.html/js/css`: mode switch (Off / Privatkunden / Geschäftskunden), manual
  refresh, stats, and the match-review UI (manual mapping or explicit skip for
  vehicles the matcher couldn't assign).

## Storage schema (`chrome.storage.local`)

| Key | Shape |
|-----|-------|
| `aplSettings` | `{ mode: 'none'\|'geschaeftskunden'\|'privatkunden', lastRun, stats: {mapped, scraped, failed, lastError} }` |
| `aplMapping` | `{ 'evdbMake\|evdbModel': 'apl-model-slug' }` |
| `aplOverrides` | `{ 'evdbMake\|evdbModel': 'apl-model-slug' \| null }` — `null` = explicit skip |
| `aplCache` | `{ 'apl-model-slug\|geschaeftskunden\|privatkunden': {fetchedAt, endpreis, kaufpreis, ersparnis, lieferzeit} }` |
| `aplSlugs`, `aplVehicles`, `aplCandidates`, `aplVariantIds` | derived lists / numeric variant IDs |

## Tests

- `node test/matcher.test.js` — matcher smoke test (86 spot-checks, >60% match).
- `node test/scraper.test.js` — GK/PK classification smoke test (real Abarth
  response + synthetic multi-tarif/multi-motor cases).
- Smoke scripts live in `/tmp/opencode` (scrape + full pipeline) — not committed.

## Known limits

- Only the overview page is modified, not detail pages; only the DE/EUR column.
- APL model lines that don't exist on APL (Smart, XPENG, Polestar, MG IM/MGS,
  Mercedes EQE/EQA, …) stay at evdb prices unless matched in the review UI.
- Prices are the base-variant APL price ("ab"-Preis); evdb prices are also
  starting prices, so the comparison is apples-to-apples.
