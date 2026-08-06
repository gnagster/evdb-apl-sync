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

    // html -> { [motorId]: [{ tag, endpreis, kaufpreis, ersparnis, lieferzeit }, ...] }
    // EVERY classified block per motor (not just PK) for the v2 offers array.
    // Tag rule (Freiberufler first, then existing GK/PK semantics): anything
    // else (behindert/Beamte/Tageszulassung/Abrufschein) is skipped.
    parseOffers(html) {
      const out = {};
      for (let block of String(html).split(/<div class="preis-item"/).slice(1)) {
        const text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        let tag;
        if (/Freiberufler/i.test(text)) tag = 'für Freiberufler';
        else if (GK_RE.test(text)) tag = 'für Geschäftskunden';
        else if (PK_RE.test(text) && !PK_BAD_RE.test(text)) tag = 'für Privatkunden';
        else continue;
        const motor = (block.match(/data-motor="(\d+)"/) || [])[1];
        if (!motor) continue;
        block = block.split(/<div class="motor-rabatt"/)[0];
        const offer = {
          tag,
          endpreis: blockField(block, 'endpreis'),
          kaufpreis: blockField(block, 'kaufpreis'),
          ersparnis: blockField(block, 'ersparnis'),
          lieferzeit: blockField(block, 'lieferzeit'),
        };
        if (offer.endpreis !== undefined) (out[motor] = out[motor] || []).push(offer);
      }
      return out;
    },

    // detail page -> { [motorId]: { kwh, kw } } from the item-motor data
    // attributes (data-sortmotor="63kWh" | "e-4ORCE 87 kWh", data-sortkw="160").
    // Unknown values stay null. Specs are static per motor id, so the pipeline
    // caches them permanently. The preisliste POST only carries motor ids, so
    // this is the only source of the specs used for pickMotor.
    parseMotorSpecs(html) {
      const out = {};
      // class is "item-motor  kW160 sprit29 clearfix" - extra classes allowed.
      for (const m of String(html).matchAll(/<div class="item-motor(?:[^"]*)"[^>]*>/g)) {
        const el = m[0];
        const id = (el.match(/data-id="(\d+)"/) || [])[1];
        if (!id) continue;
        const kw = parseFloat((el.match(/data-sortkw="([^"]*)"/) || [])[1] || '');
        const motor = (el.match(/data-sortmotor="([^"]*)"/) || [])[1] || '';
        const kwh = parseFloat((motor.match(/(\d+(?:[.,]\d+)?)\s*kWh/i) || [])[1] || '');
        out[id] = { kwh: Number.isFinite(kwh) ? kwh : null, kw: Number.isFinite(kw) ? kw : null };
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

    // One POST returning BOTH views of the price list: PK prices per motor
    // (battery matching) and every classified offer per motor (all tags) - so
    // the pipeline does a single HTTP call per variant line.
    async fetchOffers(varianteId) {
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
      return {
        byMotor: APLScraper.parsePricesByMotor(html),
        offers: APLScraper.parseOffers(html),
      };
    },
  };

  global.APLScraper = APLScraper;
  if (typeof module !== 'undefined' && module.exports) module.exports = APLScraper;
})(typeof globalThis !== 'undefined' ? globalThis : this);
