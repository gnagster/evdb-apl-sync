// Scraper core smoke test: text-based GK/PK classification (data-tarif is
// per-variant and NOT a GK/PK discriminator - verified live 2026-08-05).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const APLScraper = require('../scraper.js');

// Real Abarth 500e response: tarifs 159 (behindert) / 69 (GK) / 71 (PK).
const abarth = fs.readFileSync(path.join(__dirname, 'fixtures/apl-preisliste-abarth.html'), 'utf8');

const p = APLScraper.parsePrices(abarth);
assert.strictEqual(p.geschaeftskunden.endpreis, '30.428,45', 'GK endpreis');
assert.strictEqual(p.geschaeftskunden.kaufpreis, '29.438,45', 'GK kaufpreis');
assert.strictEqual(p.geschaeftskunden.ersparnis, '8.551,55 (22,51)', 'GK ersparnis');
assert.strictEqual(p.geschaeftskunden.lieferzeit, '4-5 Monate', 'GK lieferzeit');
assert.strictEqual(p.privatkunden.endpreis, '30.808,35', 'PK endpreis');
assert.strictEqual(p.privatkunden.lieferzeit, '4-5 Monate', 'PK lieferzeit');
assert.deepStrictEqual(Object.keys(p).sort(), ['geschaeftskunden', 'privatkunden'], 'no behindert/tarif keys');

// Synthetic multi-tarif variant (Kia EV3-style codes): 117/174 GK variants,
// 119 Tageszulassung, 118 behindert, 194 Beamte, 212 Abrufschein, 120 PK.
const kia =
  '<div class="preis-item" data-motor="3246" data-tarif="117">' +
  '<div class="data-TarifInfos"><p>Preis nur für Gewerbetreibende (hauptberuflich)</p></div>' +
  '<div class="data-endpreis">28.106,95</div><div class="data-AbholortText">Abholung beim Kia-Vertragshändler in NRW</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="3246" data-tarif="119">' +
  '<div class="data-TarifInfos"><p>Bei diesem Angebot profitieren Sie davon, dass das Fahrzeug vorab zugelassen wird</p></div>' +
  '<div class="data-endpreis">28.382,30</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="3246" data-tarif="118">' +
  '<div class="data-TarifInfos"><p>Preis nur für behinderte Mitbürger mit einem GdB von mind. 50%!</p></div>' +
  '<div class="data-endpreis">29.160,00</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="3246" data-tarif="194">' +
  '<div class="data-TarifInfos"><p>Preis nur für spezielle Berufsgruppen: Beamte</p></div>' +
  '<div class="data-endpreis">29.186,65</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="3246" data-tarif="212">' +
  '<div class="data-TarifInfos"><p>Preis nur in Verbindung mit Abrufschein (Corporate Benefits)</p></div>' +
  '<div class="data-endpreis">29.186,65</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="3246" data-tarif="120">' +
  '<div class="data-TarifInfos"><p></p></div>' +
  '<div class="data-endpreis">31.705,95</div><div class="data-AbholortText">Abholung beim Kia-Vertragshändler in NRW</div>' +
  '</div>';

const k = APLScraper.parsePrices(kia);
assert.strictEqual(k.geschaeftskunden.endpreis, '28.106,95', 'Kia GK = Gewerbetreibende block (not a later GK variant)');
assert.strictEqual(k.privatkunden.endpreis, '31.705,95', 'Kia PK = plain Abholung block (Tageszulassung/Beamte skipped)');
assert.deepStrictEqual(Object.keys(k).sort(), ['geschaeftskunden', 'privatkunden'], 'Kia: only GK+PK');

// Multi-motor: first motor's GK/PK wins.
const multi =
  '<div class="preis-item" data-motor="3246" data-tarif="117">' +
  '<div class="data-TarifInfos"><p>Preis nur für Gewerbetreibende</p></div><div class="data-endpreis">28.106,95</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="3247" data-tarif="117">' +
  '<div class="data-TarifInfos"><p>Preis nur für Gewerbetreibende</p></div><div class="data-endpreis">32.129,41</div>' +
  '</div>';
const m = APLScraper.parsePrices(multi);
assert.strictEqual(m.geschaeftskunden.endpreis, '28.106,95', 'first (base) motor wins');

// VW-style factory-pickup deal: unrestricted "Abholung im Werk" is PK
// (regression for the 2026-08-05 fix - VW/Audi/BMW deliver factory pickup).
const vw =
  '<div class="preis-item" data-motor="1034" data-tarif="49">' +
  '<div class="data-TarifInfos"><p>Bei diesem Angebot profitieren Sie davon, dass das Fahrzeug vorab zugelassen wird</p></div>' +
  '<div class="data-endpreis">31.411,88</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="1034" data-tarif="52">' +
  '<div class="data-TarifInfos"><p>Preis nur für Selbständige/Gewerbetreibende</p></div>' +
  '<div class="data-endpreis">35.205,30</div><div class="data-AbholortText">Abholung im Werk in Wolfsburg</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="1034" data-tarif="51">' +
  '<div class="data-TarifInfos"><p>Die "VW ID.Kaufprämie" haben wir in unseren Konditionen bereits berücksichtigt.</p></div>' +
  '<div class="data-endpreis">35.205,30</div><div class="data-AbholortText">Abholung im Werk in Wolfsburg</div>' +
  '</div>';
const v = APLScraper.parsePrices(vw);
assert.strictEqual(v.privatkunden.endpreis, '35.205,30', 'VW PK = unrestricted Abholung im Werk (tarif 51)');
assert.strictEqual(v.geschaeftskunden.endpreis, '35.205,30', 'VW GK = Gewerbetreibende (tarif 52)');
assert.deepStrictEqual(Object.keys(v).sort(), ['geschaeftskunden', 'privatkunden'], 'VW: Tageszulassung skipped');

// parsePricesByMotor: per-motor PK prices (battery-matching input for the pipeline).
const pm = APLScraper.parsePricesByMotor(
  '<div class="preis-item" data-motor="3122" data-tarif="51">' +
  '<div class="data-endpreis" >29.355,57</div><div class="data-TarifInfos"><p>VW ID.Kaufprämie</p></div><div class="data-AbholortText">Abholung im Werk</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="4054" data-tarif="51">' +
  '<div class="data-endpreis" >33.957,57</div><div class="data-TarifInfos"><p>VW ID.Kaufprämie</p></div><div class="data-AbholortText">Abholung im Werk</div>' +
  '</div>' +
  '<div class="preis-item" data-motor="4054" data-tarif="48">' +
  '<div class="data-endpreis" >30.834,00</div><div class="data-TarifInfos"><p>Preis nur für behinderte Mitbürger</p></div><div class="data-AbholortText">Abholung im Werk</div>' +
  '</div>');
assert.deepStrictEqual(Object.keys(pm), ['3122', '4054'], 'byMotor: only PK blocks, reviews/behindert skipped');
assert.strictEqual(pm['3122'].endpreis, '29.355,57', 'byMotor: first PK block per motor');

console.log('PASS: scraper classification ok (abarth + kia + vw + multi-motor + byMotor)');
