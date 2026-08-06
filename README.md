# APL Preise

MV3-WebExtension (Version 1.0.0) für Chrome und Firefox (121+), die die Preise
auf EV-Database (ev-database.org / .de) für bestellbare EVs durch aktuelle
APL.de-Preise ersetzt.

## Install (dev)

- **Chrome:** `chrome://extensions` → Entwicklermodus → „Entpackte Erweiterung
  laden“ → diesen Ordner auswählen.
- **Firefox:** `about:debugging` → Dieses Firefox → Temporäres Add-on laden →
  `manifest.json` auswählen (oder als XPI packen).

## Bedienung

Auf EV-Database-Seiten erscheint im Header ein 3-Button-Umschalter:
„EVDB“ / „APL Privatkunden“ / „APL Geschäftskunden“. Der Modus wird im
Browser-Storage gespeichert.

- **EVDB** = Originalpreise.
- Die APL-Modi ersetzen den Preis gematchter Modelle durch den APL-Preis des
  jeweiligen Kundensegments. Gematchte Modelle erhalten ein oranges APL-Badge;
  ein Hover auf dem Badge zeigt alle Angebote dieses Modells im Tooltip, eine
  Zeile pro Segment (für Privatkunden / für Geschäftskunden / für Freiberufler)
  mit Preis.
- Der Wechsel zurück zu EVDB stellt Originalpreise und -sortierung wieder her.

## Datenfluss

Kein Scraping im Browser. Eine nächtliche GitHub Action
(`.github/workflows/apl-prices.yml`, Cron 05:10 UTC) führt
`node tools/scrape-prices.mjs` aus, scraped APL.de, berechnet die Matches mit
Konfidenz über `matcher.js` (`buildMapping`, kWh/kW-Spezifikationsprüfung) und
committet `apl-prices.json` ins Repo (gnagster/evdb-apl-sync).

Die Pipeline cached bereits erfasste Daten in `tools/scrape-cache.json`
(committet): Preise/Offers pro Variantenlinie (TTL `APL_PRICE_TTL_H`, Standard
72 h), Slug→Varianten-Struktur (`APL_STRUCTURE_TTL_H`, 168 h) und Motorspezifikationen
(dauerhaft). Schon gematchte Linien werden nicht erneut gescraped; neue Modelle
werden sofort erfasst, ausgelaufene fallen weg.

Die Extension lädt die Datei täglich herunter (raw.githubusercontent.com, Fallback
cdn.jsdelivr.net, 24-h-Drossel) und behält bei Fehlern die letzte gute Kopie plus
`stats.lastError`.

## Datenformat (`apl-prices.json`)

`prices["Make|Model"]` = `{ slug, confidence 0..1, endpreis (Privatkunden,
Rückwärtskompatibilität), kaufpreis, ersparnis, lieferzeit, offers:
[{tag, endpreis, kaufpreis, ersparnis, lieferzeit}] }`, plus top-level
`lowConfidence[]`.

## Manuelle Overrides

`tools/overrides.json` mappt `"Make|Model"` → APL-Slug (erzwingt dieses Fahrzeug,
Konfidenz 1.0) oder `null` (explizit unmatched). Die Pipeline liest die Datei
nur lesend. Ein täglicher OpenChamber-Agent („APL Low-Confidence Review“, 07:00 UTC)
prüft `lowConfidence`- und Grenzfälle (0.85) und pflegt `overrides.json` +
`review-ledger.json`; sein Prompt ist in `tools/low-confidence-agent.md`
gespiegelt.

## Dateien

- `background.js` (Service Worker), `content.js`, `manifest.json`
- `matcher.js` (reines Modul, `module.exports` + `global.APLMatcher`,
  Helfer `specKwhOf`/`specMatch`: kWh innerhalb 15 % oder 5 kWh absolut; kW
  innerhalb 25 % oder 30 kW absolut), `scraper.js`
- `tools/scrape-prices.mjs` (nächtliche Pipeline), `tools/overrides.json`,
  `tools/review-ledger.json`, `tools/low-confidence-agent.md`,
  `tools/scrape-cache.json` (generiert)
- `apl-prices.json` (generiert), `test/` (`matcher.test.js`, `scraper.test.js`,
  Fixtures)

## Tests

- `node test/matcher.test.js` — 91 Spot-Checks.
- `node test/scraper.test.js` — Scraper-Smoke-Test.
- Content-Smoke-Test: `/tmp/opencode/smoke-content.js`.
