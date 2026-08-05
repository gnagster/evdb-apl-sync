// Pure APL scrape core: no chrome APIs, testable in Node (require) and used
// by the MV3 service worker (via importScripts).
//
// IMPORTANT (verified live 2026-08-05): the numeric data-tarif attribute is
// NOT a stable Geschäftskunden/Privatkunden discriminator - it varies per
// variant (Abarth: 159/69/71, Kia EV3: 117/174/119/118/194/212/120, VW ID.3:
// 48/51/52). The stable signal is the block's German label text:
//   - Geschäftskunden: mentions Gewerbetreibende / Selbständige
//   - Privatkunden: plain "Abholung beim {Make}-Vertragshändler" or
//     "Abholung im Werk" deal without a "Preis nur für ..." / Tageszulassung /
//     Abrufschein restriction (VW/Audi/etc. deliver factory-pickup deals)
'use strict';

(function (global) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

  const GK_RE = /Gewerbetreibende|Selbständige|Selbstständige/i;
  const PK_RE = /Abholung beim|Abholung im Werk/i;
  const PK_BAD_RE = /Preis nur für|vorab zugelassen|Abrufschein|Corporate Benefits|Beamte/i;

  function classify(blockText) {
    if (GK_RE.test(blockText)) return 'geschaeftskunden';
    if (PK_RE.test(blockText) && !PK_BAD_RE.test(blockText)) return 'privatkunden';
    return null; // behindert, Beamte, Tageszulassung, Abrufschein, ... -> skip
  }

  function blockField(block, name) {
    const attr = block.match(new RegExp('data-' + name + '="([^"]*)"', 'i'));
    if (attr) return attr[1];
    const div = block.match(new RegExp('class="data-' + name + '"[^>]*>\\s*([^<]*)', 'i'));
    return div ? div[1].trim() : undefined;
  }

  const APLScraper = {
    UA,

    // html -> { geschaeftskunden: {...}, privatkunden: {...} }
    // Raw German price strings kept as-is (decimal comma).
    parsePrices(html) {
      const out = {};
      for (let block of String(html).split(/<div class="preis-item"/).slice(1)) {
        const text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const kind = classify(text);
        if (!kind || out[kind]) continue; // first block per kind wins (base motor first)
        block = block.split(/<div class="motor-rabatt"/)[0];
        const p = {
          endpreis: blockField(block, 'endpreis'),
          kaufpreis: blockField(block, 'kaufpreis'),
          ersparnis: blockField(block, 'ersparnis'),
          lieferzeit: blockField(block, 'lieferzeit'),
        };
        if (p.endpreis !== undefined) out[kind] = p;
      }
      return out;
    },

    // html -> { [motorId]: { endpreis, kaufpreis, ersparnis, lieferzeit } }
    // PK (Privatkunden) blocks only, first block per motor. Used by the nightly
    // pipeline to match evdb battery sizes against the APL motor price rank.
    parsePricesByMotor(html) {
      const out = {};
      for (let block of String(html).split(/<div class="preis-item"/).slice(1)) {
        const text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (classify(text) !== 'privatkunden') continue;
        const motor = (block.match(/data-motor="(\d+)"/) || [])[1];
        if (!motor) continue;
        block = block.split(/<div class="motor-rabatt"/)[0];
        const p = {
          endpreis: blockField(block, 'endpreis'),
          kaufpreis: blockField(block, 'kaufpreis'),
          ersparnis: blockField(block, 'ersparnis'),
          lieferzeit: blockField(block, 'lieferzeit'),
        };
        if (p.endpreis !== undefined && !out[motor]) out[motor] = p;
      }
      return out;
    },

    // POST the price list for one variant; returns the requested kind's price
    // object or null. Throws on non-OK HTTP (caller decides retry).
    async fetchPrices(varianteId, which) {
      const res = await fetch('https://www.apl.de/sys/preisliste/getPreisliste.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Accept: '*/*',
        },
        body:
          'VarianteID=' + encodeURIComponent(varianteId) +
          '&Bonus=&Site=Preisliste',
      });
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      const html = await res.text();
      return APLScraper.parsePrices(html)[which] || null;
    },

    // Like fetchPrices but returns every PK motor's price object keyed by motor
    // id (see parsePricesByMotor).
    async fetchPKByMotor(varianteId) {
      const res = await fetch('https://www.apl.de/sys/preisliste/getPreisliste.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Accept: '*/*',
        },
        body:
          'VarianteID=' + encodeURIComponent(varianteId) +
          '&Bonus=&Site=Preisliste',
      });
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return APLScraper.parsePricesByMotor(await res.text());
    },
  };

  global.APLScraper = APLScraper;
  if (typeof module !== 'undefined' && module.exports) module.exports = APLScraper;
})(typeof globalThis !== 'undefined' ? globalThis : this);
