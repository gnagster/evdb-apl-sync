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

## Dashboard

[Preis-Dashboard öffnen](https://gnagster.github.io/evdb-apl-sync/)

Nach Prüfung eines gültigen Repo-Tokens zeigt die Übersicht Fahrzeugpreise,
Angebote für alle Kundenarten, Lieferzeiten, Abrufdatum und die genaue APL-Quelle. Suche, Hersteller-, Preis-
und Zuordnungsfilter lassen sich kombinieren. Die gefilterte Tabelle kann als
CSV und der aktuelle Stand einschließlich Entwürfen als JSON exportiert werden.

Zum Öffnen ein kurzlebiges, fine-grained Personal Access Token eingeben:
nur das Repository `evdb-apl-sync` auswählen,
**Contents: Read and write** und **Actions: Read and write** erlauben. Das Token
wird im lokalen Browserspeicher gespeichert und beim nächsten Öffnen erneut
geprüft. **Abmelden** entfernt das Token und sperrt die Übersicht. Ungültige
oder abgelaufene Tokens werden entfernt. Keine Zugangsdaten in Dateien,
Commits oder Exporten speichern.

Die Zugangssperre betrifft die Dashboard-Oberfläche. GitHub Pages, das Repository
und die Preisdateien bleiben öffentlich zugänglich; vertrauliche Daten benötigen
eine serverseitige Zugangskontrolle. Wer Zugriff auf dieses Browserprofil hat,
kann auch das dort gespeicherte Token verwenden.

Fahrzeugdetails erlauben getrennte Korrekturen der Fahrzeugwerte und einzelnen
Kundenangebote. Die Quelle lässt sich bis zu APL-Modell, Ausstattungsvariante,
Motor und Tarif auswählen. **Varianten laden / aktualisieren** ergänzt fehlende
Angebote. Bei einem Quellenwechsel werden bestehende Zahlenkorrekturen für dieses
Angebot nach Bestätigung entfernt. **In GitHub speichern** übernimmt alle
Entwürfe in einem Commit; bei einem Schreibkonflikt bleiben die Entwürfe erhalten.
Vor einem Neuladen können Entwürfe im JSON-Export gesichert werden.

Die Datei `tools/dashboard-overrides.json` trennt `mapping` (Quellen oder `null`
zum Ausschließen) von `prices` (quellengebundene Feldkorrekturen). Diese Datei ist
öffentlich im Repository. Änderungen lösen eine gezielte Neuberechnung aus.
Zahlenkorrekturen überstehen spätere Abrufe; **Preiswerte zurücksetzen** entfernt
sie. **Zuordnung zurücksetzen** stellt den bestehenden manuellen Override bzw.
die automatische Zuordnung wieder her. Ausgeschlossene Fahrzeuge können unter
**Meine Korrekturen** wiederhergestellt werden.

**Fahrzeug neu abrufen** aktualisiert die erforderliche Modellfamilie;
**Dieses Angebot neu abrufen** lädt dessen Variantenpreisliste trotz frischem
Cache. Alle Fahrzeuge mit derselben aktualisierten Quelle werden mitgezogen,
andere Fahrzeuge bleiben unverändert. Lauf und Ergebnis sind unter **Abrufe**
sichtbar. Nicht mehr verfügbare Angebote und parallele Änderungen führen zu
sichtbaren Fehlern, statt bestehende Daten zu überschreiben. Bei ungespeicherten
Entwürfen wird kein Abruf gestartet. Die Erweiterung lädt die veröffentlichte
Preisdatei mit ihrer bisherigen täglichen Aktualisierung.

GitHub Pages veröffentlicht ausschließlich `dashboard/`, über den Workflow
`dashboard.yml`. Die Preise werden aus dem aktuellen Repository-Stand geladen,
nicht in die Website eingebettet. Zum lokalen Prüfen einen statischen Server im
Repo starten und `dashboard/` öffnen; auch die lokale Oberfläche nutzt GitHub als
Datenquelle.

Zugangstests: `node test/dashboard-auth.test.js` prüfen Token-Speicherung,
erneute Prüfung, Sperre, Abmelden und abgelaufene Sitzungen.

Zusätzliche Tests: `node test/dashboard.test.js`. Sie prüfen Quellenkennungen,
gebundene Korrekturen, Filter, Einzelabrufe, Fehlererhaltung und das Zusammenführen
paralleler Veröffentlichungen. Der Preisworkflow akzeptiert `mode` (`full`,
`vehicle`, `offer`, `catalogue`, `corrections`), `target` und `request_id`.


## Vollständige EVDB-Datenbank

Das [Dashboard](https://gnagster.github.io/evdb-apl-sync/) enthält alle Fahrzeuge
von [EV Database](https://ev-database.org/), einschließlich angekündigter und
früherer Modelle. Standard: **Bestellbar · Meistgesehen**. Alle aktuellen
EVDB-Fahrzeugfilter, deren Bereiche und 18 Sortierungen stehen deutschsprachig
bereit; zusätzlich Kundenart, unsichere Zuordnung und Korrekturstatus.
Mehrfachauswahlen gelten innerhalb einer Gruppe als ODER, Gruppen und einzelne
Ausstattungsanforderungen als UND. Unveränderte volle Bereiche schließen keine
unbekannten Angaben aus. Eingeschränkte Bereiche bieten deren ausdrückliche
Einbeziehung oder alleinige Auswahl. Jahresfilter prüfen Zeitüberschneidung;
laufende Verfügbarkeit besitzt ein offenes Ende.

Preise verwenden APL-Angebote mit ihren quellengebundenen Korrekturen, sonst den
**deutschen EVDB-Listenpreis**. Ein Fahrzeug ohne Preis bleibt ohne eingeschränkten
Preisfilter sichtbar. Bei Kundenart-Auswahl werden ausschließlich Fahrzeuge mit
diesem Angebot angezeigt. Preis/km wird aus dem wirksamen Preis berechnet.
CSV und JSON enthalten die gefilterten Fahrzeuge samt IDs und technischen Werten;
JSON enthält zusätzlich die Korrekturentwürfe. Die Tokensperre bleibt bestehen.

`evdb-vehicles.json` enthält metrische Übersichtsdaten, deutsche Listenpreise,
Quellenlinks, Einheiten und die aktuellen Filterdefinitionen. Der Workflow
`evdb.yml` holt täglich um 05:00 UTC genau eine Übersichtsseite ohne zusätzliche
Fahrzeugdetailabrufe. EVDB und APL zeigen getrennte Abrufzeitpunkte und werden
unabhängig veröffentlicht. Ein fehlerhafter oder unvollständiger EVDB-Abruf lässt
den letzten gültigen Bestand bestehen. Änderungen am Filter-/Sortierinventar
stoppen die Veröffentlichung zur Parserprüfung. Parallel veröffentlichte
APL-Preise können neuere EVDB-Daten nicht überschreiben.

Die Preisdatei mit `schemaVersion: 2` verwendet `pricesByEvdbId` mit Schlüsseln
wie `evdb:3657`; Zahlenkorrekturen stehen roh in `originalPricesByEvdbId`.
Neue Dashboard-Korrekturen und gezielte Fahrzeugabrufe verwenden dieselben IDs.
Die Erweiterung bevorzugt diese ID-Zuordnung. Alte Preisdateien werden weiterhin
unterstützt. Die bisherige `prices`-Ansicht für ältere Erweiterungen wird nur bei
über alle Generationen eindeutigem Hersteller-/Modellnamen veröffentlicht.
Automatische Zuordnungen gelten nur für bestellbare Fahrzeuge; gespeicherte
Quellen können auch für angekündigte oder frühere Fahrzeuge verwendet werden.
Alte Korrekturen werden nur bei eindeutigen Namen übernommen; mehrdeutige Einträge
bleiben als Konflikte in der Korrekturliste erhalten und müssen anhand der IDs
neu zugeordnet werden. Ausschlüsse gelten auch ohne APL-Angebot.

Prüfung: `node test/evdb.test.js` testet Parser, Inventar, alle Filtergruppen und
Sortierungen, Grenzen, unbekannte Werte, offene Obergrenzen, Jahresüberschneidung,
Preisvorrang, Kundenangebote, IDs und Erweiterungskompatibilität. Die vorhandenen
Scraper-, Zuordnungs-, Veröffentlichungs- und Zugangstests bleiben aktiv.
Live-Abruf: `node tools/scrape-evdb.mjs` und `node tools/scrape-prices.mjs`.
Die Veröffentlichungsskripte sind für isolierte CI-Checkouts bestimmt.

In den Fahrzeugdetails lässt sich **Nicht bei APL gelistet – EVDB-Listenpreis
verwenden** ankreuzen. Nach dem Speichern bleibt das Fahrzeug sichtbar, verwendet
ausschließlich seinen deutschen EVDB-Listenpreis und wird bei APL-Zuordnungen
übersprungen. Vorhandene APL-Zuordnungen und Zahlenkorrekturen werden beim Wechsel
entfernt; Zahlenkorrekturen erfordern eine Bestätigung. Ohne EVDB-Preis erscheint
kein Preis. Entfernen der Markierung aktiviert die automatische APL-Zuordnung
wieder. Die Korrektur wird als `mapping["evdb:ID"] = { "evdbOnly": true }` gespeichert.


**Varianten laden / aktualisieren** zeigt den Abrufstatus unmittelbar in der
Quellenauswahl an. Der Abruf läuft über GitHub Actions; Warteschlange und Lauf
werden automatisch abgefragt und verlinkt. Erfolgreiche Ergebnisse ergänzen die
Varianten, Motoren und Angebote im geöffneten Detailfenster. Vorhandene Eingaben,
Auswahlen und Korrekturentwürfe bleiben erhalten; ein manuelles Neuladen ist nicht
nötig. Varianten können auch mit ungespeicherten Entwürfen geladen werden, da der
Abruf die gespeicherten Repository-Zuordnungen verwendet. Bei Fehlern bleiben die
bisherigen Auswahlwerte verfügbar. Falls nur das Laden der Ergebnisse scheitert,
holt **Ergebnisse erneut laden** sie ohne erneutes Scraping ab.
