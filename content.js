// EV-Database DE overview: replace DE starting prices with APL.de prices for
// orderable ("Bestellbar") vehicles, then re-trigger jplist so sort/filter run
// against the new hidden numeric values.
//
// v0.2 (Firefox fork): prices come pre-scraped from apl-prices.json (GitHub
// Action) via background.js, keyed directly by "Make|Model". The popup is
// gone; the mode switcher (EVDB / APL Privatkunden / APL Geschäftkunden) is
// injected into the page header. Mode semantics per model:
//   evdb            -> leave the original EV-Database price, no APL badge
//   privatkunden    -> offer with tag === 'für Privatkunden', else flat endpreis
//   geschaeftskunden-> offer with tag === 'für Geschäftskunden', else flat endpreis
// If neither the tag nor the flat endpreis exists, the evdb price is left
// untouched and no badge is shown. No per-model staleness checks: the JSON is
// the cache, apply regardless.
'use strict';

// Chrome MV3 has only the callback-based `chrome.*` API, not the promise-based
// `browser.*`. Gated shim covering exactly the methods used below; no-op in
// Firefox (native browser.*) and in Node (no chrome -> module.exports intact).
if (typeof globalThis !== 'undefined' && !globalThis.browser && typeof chrome !== 'undefined') {
  const promisify = (fn, thisArg) => (...args) =>
    new Promise((resolve, reject) => {
      fn.call(thisArg, ...args, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    });
  globalThis.browser = {
    storage: {
      local: {
        get: promisify(chrome.storage.local.get, chrome.storage.local),
        set: promisify(chrome.storage.local.set, chrome.storage.local),
      },
      onChanged: chrome.storage.onChanged,
    },
    runtime: {
      sendMessage: promisify(chrome.runtime.sendMessage, chrome.runtime),
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (shared with the Node smoke test via module.exports).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

// Mode -> German offer tag (APL's own labels; there is no stable numeric tarif).
const MODES = {
  privatkunden: 'für Privatkunden',
  geschaeftskunden: 'für Geschäftskunden',
};

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

// Endpreis string for a mode, or null when nothing usable. Chosen tag first,
// the other mode's tag as cross-fallback (only-one-price case), flat endpreis
// last. Entry shape (v2): {endpreis, offers:[{tag,endpreis}]}.
function selectEndpreis(entry, mode) {
  if (!entry) return null;
  const offers = (entry.offers || []).filter((o) => o && o.endpreis != null);
  const own = offers.find((o) => o.tag === MODES[mode]);
  if (own) return own.endpreis;
  const otherTag = mode === 'privatkunden' ? MODES.geschaeftskunden : MODES.privatkunden;
  const other = offers.find((o) => o.tag === otherTag);
  if (other) return other.endpreis;
  return entry.endpreis != null ? entry.endpreis : null;
}

// Tooltip lines: one per offer "<tag> — <formatted endpreis>". When a model
// has no offers, its flat endpreis is labelled "für Privatkunden".
function offerLines(entry) {
  const lines = [];
  const offers = (entry && entry.offers) || [];
  if (offers.length) {
    for (const o of offers) {
      const p = formatPrice(o && o.endpreis);
      if (p !== null) lines.push((o.tag || 'APL') + ' — ' + p);
    }
  } else if (entry && entry.endpreis != null) {
    const p = formatPrice(entry.endpreis);
    if (p !== null) lines.push('für Privatkunden — ' + p);
  }
  return lines;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parsePriceNum, formatPrice, pricePerKm, parseRangeKm, DAY,
    selectEndpreis, offerLines, MODES,
  };
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

    // Snapshot original values on first touch so switching back to EVDB (or
    // away from an unusable entry) can restore the exact original DOM state.
    function snapshotOriginal(de, item) {
      if (de.dataset.aplOrig) return;
      const pf = item.querySelector('.pricefilter.hidden');
      const ps = item.querySelector('.pricesort.hidden');
      const pp = item.querySelector('.priceperrange.hidden');
      const ppv = item.querySelector('.priceperrange_p');
      de.dataset.aplOrig = JSON.stringify({
        price: de.textContent,
        pf: pf ? pf.textContent : null,
        ps: ps ? ps.textContent : null,
        pp: pp ? pp.textContent : null,
        ppv: ppv ? ppv.textContent : null,
      });
    }

    // Apply one APL price to one list item. Returns true if the DOM changed
    // (so the caller knows to re-run jplist). priceText === null restores the
    // original evdb values and removes the badge.
    function applyOrRestore(item, priceText, priceNum, entry) {
      const de = item.querySelector('.price_buy.current .country_de');
      if (!de) return false;

      if (priceText === null) {
        let changed = false;
        const snap = de.dataset.aplOrig;
        if (snap) {
          try {
            const s = JSON.parse(snap);
            de.textContent = s.price;
            const pf = item.querySelector('.pricefilter.hidden');
            const ps = item.querySelector('.pricesort.hidden');
            const pp = item.querySelector('.priceperrange.hidden');
            const ppv = item.querySelector('.priceperrange_p');
            if (pf) pf.textContent = s.pf;
            if (ps) ps.textContent = s.ps;
            if (pp) pp.textContent = s.pp;
            if (ppv) ppv.textContent = s.ppv;
            changed = true;
          } catch (e) {
            // malformed snapshot: leave as-is
          }
          delete de.dataset.aplOrig;
        }
        const badge = item.querySelector('[data-apl-badge]');
        if (badge) {
          badge.remove();
          changed = true;
        }
        delete de.dataset.aplPrice;
        return changed;
      }

      snapshotOriginal(de, item);
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
      const pp = item.querySelector('.priceperrange.hidden');
      const ppv = item.querySelector('.priceperrange_p');
      if (perKm !== null) {
        if (pp) pp.textContent = String(perKm);
        if (ppv) ppv.textContent = '€' + perKm.toLocaleString('en-US') + ' /km';
      }

      ensureBadge(de, entry);
      return changed;
    }

    // -----------------------------------------------------------------------
    // APL badge + hover/focus tooltip. Tooltip is appended to document.body
    // with fixed positioning computed from the badge rect, so the page's
    // overflow/transform CSS can't clip it. Inline styles everywhere on
    // purpose: page stylesheets can't beat them.
    // -----------------------------------------------------------------------

    function ensureBadge(de, entry) {
      const parent = de.parentElement;
      if (!parent) return;
      let badge = parent.querySelector('[data-apl-badge]');
      if (!badge) {
        badge = document.createElement('span');
        badge.dataset.aplBadge = '1';
        badge.textContent = 'APL';
        badge.setAttribute('aria-label', 'APL Preise');
        badge.tabIndex = 0; // keyboard focus opens the tooltip
        badge.style.cssText =
          'display:inline-block;margin-left:5px;padding:0 4px;font-size:10px;' +
          'line-height:14px;font-weight:700;color:#fff;background:#e8590c;' +
          'border-radius:3px;vertical-align:top;cursor:default;';
        badge.addEventListener('mouseenter', () => showTooltip(badge));
        badge.addEventListener('mouseleave', hideTooltip);
        badge.addEventListener('focus', () => showTooltip(badge));
        badge.addEventListener('blur', hideTooltip);
        parent.appendChild(badge);
      }
      // Refresh lines every run so a newer aplData file updates open tooltips.
      badge.dataset.aplLines = JSON.stringify(offerLines(entry));
    }

    let tooltip = null;

    function ensureTooltip() {
      if (tooltip) return tooltip;
      tooltip = document.createElement('div');
      tooltip.setAttribute('role', 'tooltip');
      tooltip.style.cssText =
        'position:fixed;z-index:2147483647;display:none;background:#1e2226;' +
        'color:#e8e8e8;border:1px solid #3d434b;border-radius:4px;' +
        'padding:6px 9px;font:11px/1.45 -apple-system,"Segoe UI",Arial,sans-serif;' +
        'box-shadow:0 3px 10px rgba(0,0,0,.4);pointer-events:none;white-space:nowrap;';
      document.body.appendChild(tooltip);
      return tooltip;
    }

    function showTooltip(badge) {
      let lines = [];
      try {
        lines = JSON.parse(badge.dataset.aplLines || '[]');
      } catch (e) {
        /* keep [] */
      }
      if (!lines.length) return;
      const tt = ensureTooltip();
      tt.replaceChildren();
      const h = document.createElement('div');
      h.textContent = 'APL Preise';
      h.style.cssText = 'font-weight:700;margin-bottom:3px;color:#ff8a4d;';
      tt.appendChild(h);
      for (const line of lines) {
        const d = document.createElement('div');
        d.textContent = line;
        tt.appendChild(d);
      }
      tt.style.display = 'block';
      tt.style.visibility = 'hidden'; // measure without flashing
      const r = badge.getBoundingClientRect();
      const tr = tt.getBoundingClientRect();
      let left = r.left + r.width / 2 - tr.width / 2;
      let top = r.top - tr.height - 6; // above the badge
      if (top < 8) top = r.bottom + 6; // flip below when no room above
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
      tt.style.visibility = 'visible';
    }

    function hideTooltip() {
      if (tooltip) tooltip.style.display = 'none';
    }

    // The page scrolls under a fixed tooltip -> dismiss it.
    document.addEventListener('scroll', hideTooltip, true);

    // -----------------------------------------------------------------------
    // Status toasts (small orange/red notifications, bottom-right).
    // -----------------------------------------------------------------------

    let toastHost = null;

    function ensureToastHost() {
      if (toastHost && document.body.contains(toastHost)) return toastHost;
      toastHost = document.createElement('div');
      toastHost.style.cssText =
        'position:fixed;right:12px;bottom:12px;z-index:2147483646;' +
        'display:flex;flex-direction:column;gap:6px;align-items:flex-end;' +
        'pointer-events:none;max-width:min(360px,90vw);';
      document.body.appendChild(toastHost);
      return toastHost;
    }

    function showToast(text, kind) {
      const host = ensureToastHost();
      const t = document.createElement('div');
      t.setAttribute('role', 'status');
      t.textContent = text;
      const bg = kind === 'error' ? '#d33' : '#e8590c';
      t.style.cssText =
        'padding:8px 12px;border-radius:4px;font:600 12px/1.4 -apple-system,"Segoe UI",Arial,sans-serif;' +
        'color:#fff;background:' + bg + ';box-shadow:0 3px 10px rgba(0,0,0,.35);' +
        'opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;';
      host.appendChild(t);
      requestAnimationFrame(() => {
        t.style.opacity = '1';
        t.style.transform = 'none';
      });
      setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateY(6px)';
        setTimeout(() => t.remove(), 250);
      }, 5000);
    }

    // -----------------------------------------------------------------------
    // Mode switcher, injected into .subheader-title right after the <h1>.
    // -----------------------------------------------------------------------

    const MODE_BTNS = [
      ['evdb', 'EVDB'],
      ['privatkunden', 'APL Privatkunden'],
      ['geschaeftskunden', 'APL Geschäftkunden'],
    ];
    let currentMode = 'evdb';

    function ensureSwitcher() {
      const holder = document.querySelector('.subheader-title');
      if (!holder || holder.querySelector('.apl-mode-switch')) return;
      const seg = document.createElement('div');
      seg.className = 'apl-mode-switch';
      seg.style.cssText = 'display:inline-flex;margin-left:12px;vertical-align:middle;';
      const base =
        'font:600 10.5px/1.4 -apple-system,"Segoe UI",Arial,sans-serif;' +
        'padding:3px 9px;background:transparent;border:1px solid #c8ccd0;' +
        'color:#555;cursor:pointer;transition:background .15s,color .15s;';
      MODE_BTNS.forEach(([mode, label], i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.mode = mode;
        b.textContent = label;
        let css = base;
        if (i === 0) css += 'border-radius:3px 0 0 3px;';
        else {
          css += 'margin-left:-1px;';
          if (i === MODE_BTNS.length - 1) css += 'border-radius:0 3px 3px 0;';
        }
        b.style.cssText = css;
        b.addEventListener('mouseenter', () => {
          if (b.dataset.mode !== currentMode) b.style.background = '#f1f3f5';
        });
        b.addEventListener('mouseleave', () => {
          if (b.dataset.mode !== currentMode) b.style.background = 'transparent';
        });
        b.addEventListener('click', () => setMode(mode));
        seg.appendChild(b);
      });
      const h1 = holder.querySelector('h1');
      holder.insertBefore(seg, h1 ? h1.nextSibling : holder.firstChild);
      setSwitcherActive(currentMode);
    }

    function setSwitcherActive(mode) {
      currentMode =
        mode === 'privatkunden' || mode === 'geschaeftskunden' ? mode : 'evdb';
      const seg = document.querySelector('.apl-mode-switch');
      if (!seg) return;
      for (const b of seg.querySelectorAll('button')) {
        const active = b.dataset.mode === currentMode;
        b.style.background = active ? '#e8590c' : 'transparent';
        b.style.color = active ? '#fff' : '#555';
        b.style.borderColor = active ? '#e8590c' : '#c8ccd0';
        b.setAttribute('aria-pressed', String(active));
      }
    }

    async function setMode(mode) {
      setSwitcherActive(mode); // instant feedback; run() re-syncs from storage
      try {
        const st = await get('aplSettings');
        await browser.storage.local.set({ aplSettings: { ...(st.aplSettings || {}), mode } });
      } catch (e) {
        // storage write failed: run() will re-sync the UI from storage
      }
      browser.runtime.sendMessage({ type: 'setMode', mode }).catch(() => {});
      run();
    }

    // -----------------------------------------------------------------------
    // Apply loop + jplist refresh.
    // -----------------------------------------------------------------------

    let timer = null;
    let firstRun = true;

    function triggerRefresh() {
      // Content script world can't see window.jplist; run in the page world.
      // Must be an external file (web_accessible_resources): the page's CSP
      // blocks inline scripts, but allows the extension's own origin.
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('jplist-refresh.js');
      s.addEventListener('load', () => s.remove());
      document.documentElement.appendChild(s);
    }

    async function run() {
      try {
        ensureSwitcher();
        hideTooltip();
        const st = await get(['aplSettings', 'aplData']);
        const mode = (st.aplSettings || {}).mode;
        setSwitcherActive(mode);
        const prices = (st.aplData || {}).prices || {};
        const isApl = mode === 'privatkunden' || mode === 'geschaeftskunden';

        let modified = 0;
        let recognized = 0;
        for (const item of document.querySelectorAll('.list-item')) {
          try {
            if (!item.querySelector('.availability.current')) continue; // not orderable
            const key = itemKey(item);
            if (!key) continue;
            const entry = prices[key];
            if (entry) recognized++;
            let priceText = null;
            let priceNum = null;
            if (isApl && entry) {
              const end = selectEndpreis(entry, mode);
              priceNum = parsePriceNum(end);
              if (end != null && priceNum !== null) priceText = formatPrice(end);
            }
            if (applyOrRestore(item, priceText, priceNum, entry)) modified++;
          } catch (e) {
            // one bad item must not break the loop
          }
        }

        if (modified > 0) {
          triggerRefresh();
          console.info('[apl-prices] updated ' + modified + ' items');
        }

        // Status toast: recognized models, DB fetch time, replaced prices.
        // Show on the first run (page load) and whenever prices changed.
        if (firstRun || modified > 0) {
          firstRun = false;
          const fetchedAt = (st.aplData && st.aplData.fetchedAt) || null;
          const when = fetchedAt
            ? new Date(fetchedAt).toLocaleString('de-DE', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })
            : 'nie';
          showToast(
            recognized + ' Modelle erkannt, Datenbank ' + when + ' abgerufen, ' + modified + ' Preise ersetzt.'
          );
        }
      } catch (e) {
        console.warn('[apl-prices]', e);
      }
    }

    // Safety net for content-pre.js: if jplist pagination is still active at
    // idle (the pre-init patch didn't land, e.g. this tab was already open when
    // the extension was reloaded), the list only holds the current page and
    // prices/sort miss the rest. Patch the page size and reload once.
    if (sessionStorage.getItem('apl-prices-pagfix') !== '1') {
      const pag = document.querySelector('[data-jplist-control="pagination"]');
      if (
        pag &&
        pag.getAttribute('data-items-per-page') !== '100000' &&
        document.querySelectorAll('.list-item').length < 20
      ) {
        sessionStorage.setItem('apl-prices-pagfix', '1');
        pag.setAttribute('data-items-per-page', '100000');
        location.reload();
        return;
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

    // Re-apply when background.js refreshes the JSON while this tab is open.
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.aplData || changes.aplSettings) {
        clearTimeout(timer);
        timer = setTimeout(run, 800);
      }
    });
  })();
}
