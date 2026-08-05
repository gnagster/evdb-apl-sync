// EV-Database DE overview: replace DE starting prices with APL.de prices for
// orderable ("Bestellbar") vehicles, then re-trigger jplist so sort/filter run
// against the new hidden numeric values.
'use strict';

// ---------------------------------------------------------------------------
// Pure helpers (shared with the Node smoke test via module.exports).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

// Cache keys and mode labels are the same string ('geschaeftskunden' /
// 'privatkunden'); there is no numeric tarif constant (APL's data-tarif
// values vary per variant and are not a GK/PK discriminator).

// "30.428,45" | "50.990" | "€12.345,00" -> 30428 (integer euros, rounded).
function parsePriceNum(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[€\s]/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? Math.round(n) : null;
}

// 30428 -> "€30,428" (comma thousands, matching the page's own display).
function formatPrice(raw) {
  const n = parsePriceNum(raw);
  return n === null ? null : '€' + n.toLocaleString('en-US');
}

// 50990 / 470 -> 108
function pricePerKm(priceNum, rangeKm) {
  if (!rangeKm) return null;
  return Math.round(priceNum / rangeKm);
}

// "450 km" -> 450
function parseRangeKm(text) {
  const m = String(text || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePriceNum, formatPrice, pricePerKm, parseRangeKm, DAY };
} else {
  // -------------------------------------------------------------------------
  // Content script (browser only).
  // -------------------------------------------------------------------------
  (() => {
    const get = (keys) => browser.storage.local.get(keys);

    // Same key as background.js: "Make|Model" from the title spans.
    function itemKey(item) {
      const title = item.querySelector('.title');
      if (!title) return null;
      const makeEl = title.querySelector('span');
      const modelEl = title.querySelector('.model');
      if (!makeEl || !modelEl) return null;
      const make = makeEl.textContent.trim();
      const model = modelEl.textContent.replace(/\s+/g, ' ').trim();
      return make + '|' + model;
    }

    // Apply one cached APL price to one list item. Returns true if changed.
    function applyPrice(item, slug, cached) {
      if (!cached || Date.now() - cached.fetchedAt >= DAY) return false; // stale/missing -> leave alone
      const endpreis = cached.endpreis;
      const priceNum = parsePriceNum(endpreis);
      if (endpreis == null || priceNum === null) return false;

      const de = item.querySelector('.price_buy.current .country_de');
      if (!de) return false;
      const priceText = formatPrice(endpreis);
      const changed = de.textContent !== priceText;
      de.textContent = priceText;
      de.dataset.aplPrice = '1';

      // Hidden jplist numeric spans (sort/filter read these).
      const pf = item.querySelector('.pricefilter.hidden');
      const ps = item.querySelector('.pricesort.hidden');
      if (pf) pf.textContent = String(priceNum);
      if (ps) ps.textContent = String(priceNum);

      // Price/range figure: visible "€88 /km" + hidden integer.
      const rangeKm = (() => {
        const el = item.querySelector('.erange_real');
        return el ? parseRangeKm(el.textContent) : null;
      })();
      const perKm = pricePerKm(priceNum, rangeKm);
      const ppHidden = item.querySelector('.priceperrange.hidden');
      const ppVis = item.querySelector('.priceperrange_p');
      if (perKm !== null) {
        if (ppHidden) ppHidden.textContent = String(perKm);
        if (ppVis) ppVis.textContent = '€' + perKm.toLocaleString('en-US') + ' /km';
      }

      // Minimal APL badge next to the price.
      if (de.parentElement && !de.parentElement.querySelector('[data-apl-badge]')) {
        const b = document.createElement('span');
        b.dataset.aplBadge = '1';
        b.textContent = 'APL';
        b.style.cssText =
          'display:inline-block;margin-left:5px;padding:0 4px;font-size:10px;' +
          'line-height:14px;font-weight:700;color:#fff;background:#e8590c;' +
          'border-radius:3px;vertical-align:top;';
        de.parentElement.appendChild(b);
      }
      return changed;
    }

    let kicked = false;
    let timer = null;

    function triggerRefresh() {
      // Content script world can't see window.jplist; run in the page world.
      const s = document.createElement('script');
      s.textContent = 'window.jplist && window.jplist.refresh();';
      document.documentElement.appendChild(s);
      s.remove();
    }

    async function run() {
      try {
        const st = await get(['aplSettings', 'aplMapping', 'aplOverrides', 'aplCache']);
        const mode = (st.aplSettings || {}).mode;
        if (mode !== 'geschaeftskunden' && mode !== 'privatkunden') return; // mode none / unknown

        const eff = { ...(st.aplMapping || {}) };
        for (const [k, v] of Object.entries(st.aplOverrides || {})) {
          if (v === null) delete eff[k];
          else eff[k] = v;
        }

        const aplCache = st.aplCache || {};
        let modified = 0;
        for (const item of document.querySelectorAll('.list-item')) {
          try {
            if (!item.querySelector('.availability.current')) continue; // not orderable
            const key = itemKey(item);
            if (!key) continue;
            const slug = eff[key];
            if (!slug) continue;
            if (applyPrice(item, slug, aplCache[slug + '|' + mode])) modified++;
          } catch (e) {
            // one bad item must not break the loop
          }
        }

        if (modified > 0) {
          triggerRefresh();
          console.info('[apl-prices] updated ' + modified + ' prices');
        }

        // Kick the background once per page load so missing/stale cache gets refilled.
        if (!kicked) {
          kicked = true;
          browser.runtime.sendMessage({ type: 'run', manual: false }).catch(() => {});
        }
      } catch (e) {
        console.warn('[apl-prices]', e);
      }
    }

    function boot() {
      if (!document.querySelector('.list-item')) return false;
      run();
      const list = document.querySelector('.list');
      if (list) {
        new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(run, 800);
        }).observe(list, { childList: true, subtree: true });
      }
      return true;
    }

    if (!boot()) {
      const iv = setInterval(() => {
        if (boot()) clearInterval(iv);
      }, 800);
      setTimeout(() => clearInterval(iv), 20000);
    }

    // Re-apply when the background finishes scraping while this tab is open.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (['aplCache', 'aplSettings', 'aplMapping', 'aplOverrides'].some((k) => changes[k])) {
        clearTimeout(timer);
        timer = setTimeout(run, 800);
      }
    });
  })();
}
