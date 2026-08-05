'use strict';
// Firefox event-page background: matcher.js + scraper.js load first via the
// manifest (they attach APLMatcher/APLScraper to globalThis). importScripts
// does not exist in Firefox background pages (service-worker-only API).

const UA = APLScraper.UA;
const DAY = 24 * 60 * 60 * 1000;
const CONCURRENCY = 4;
const DELAY = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (keys) => browser.storage.local.get(keys);
const set = (obj) => browser.storage.local.set(obj);

async function fetchAplSlugs() {
  const res = await fetch('https://www.apl.de/sitemap.xml', {
    headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' },
  });
  if (!res.ok) throw new Error('sitemap HTTP ' + res.status);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>\s*([^<]*\/neuwagen\/[^<]*?\/modellvarianten\/)\s*<\/loc>/gi)].map((m) => m[1]);
}

async function fetchEvdbVehicles() {
  const res = await fetch('https://ev-database.org/', {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  if (!res.ok) throw new Error('evdb HTTP ' + res.status);
  const html = await res.text();
  const vehicles = [];
  for (const chunk of String(html).split('<div class="list-item" data-jplist-item>').slice(1)) {
    // Only vehicles currently orderable ("Bestellbar").
    if (!/class="availability current"/.test(chunk)) continue;
    const title = chunk.match(/class="title">([\s\S]*?)<\/a>/);
    if (!title) continue;
    const href = chunk.match(/href="(\/car\/\d+\/[^"]+)"/);
    const id = href ? Number(((href[1].match(/\/car\/(\d+)\//) || [])[1])) : null;
    const make = (title[1].match(/<span class="[a-z0-9_]+">([^<]*)<\/span>/) || [])[1];
    const modelRaw = (title[1].match(/class="model">([\s\S]*?)<\/span>/) || [])[1];
    const model = modelRaw ? modelRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    const shape = (chunk.match(/class="shape-([a-z]+) hidden"/) || [])[1];
    if (!make || !model) continue;
    vehicles.push({ id, make: make.trim(), model, shape });
  }
  return vehicles;
}

// ---------------------------------------------------------------------------
// Mapping (lazy, rebuild when missing or stale > 24h).
// ---------------------------------------------------------------------------
let mappingPromise = null;

async function ensureMapping() {
  if (mappingPromise) return mappingPromise;
  mappingPromise = (async () => {
    const st = await get(['aplSlugs', 'aplVehicles', 'aplMapping', 'aplCandidates', 'aplMappingBuiltAt']);
    if (
      st.aplSlugs && st.aplVehicles && st.aplMapping && st.aplCandidates &&
      st.aplMappingBuiltAt && Date.now() - st.aplMappingBuiltAt < DAY
    ) {
      return { mapping: st.aplMapping, candidates: st.aplCandidates };
    }

    // Fetch what's missing; keep existing data on partial failure.
    let { aplSlugs, aplVehicles } = st;
    if (!aplSlugs) {
      try { aplSlugs = await fetchAplSlugs(); } catch (e) { console.error('aplSlugs fetch failed:', e); }
    }
    if (!aplVehicles) {
      try { aplVehicles = await fetchEvdbVehicles(); } catch (e) { console.error('aplVehicles fetch failed:', e); }
    }
    if (!aplSlugs || !aplSlugs.length || !aplVehicles || !aplVehicles.length) {
      return { mapping: st.aplMapping || {}, candidates: st.aplCandidates || {} };
    }

    const paths = aplSlugs.map((u) => { try { return new URL(u).pathname; } catch { return u; } });
    const built = APLMatcher.buildMapping(aplVehicles, paths);
    await set({
      aplSlugs,
      aplVehicles,
      aplMapping: built.mapping,
      aplCandidates: built.candidates,
      aplMappingBuiltAt: Date.now(),
    });
    return { mapping: built.mapping, candidates: built.candidates };
  })().finally(() => { mappingPromise = null; });
  return mappingPromise;
}

async function effectiveMapping() {
  const { aplMapping = {}, aplOverrides = {} } = await get(['aplMapping', 'aplOverrides']);
  const eff = { ...aplMapping };
  for (const [key, slug] of Object.entries(aplOverrides)) {
    if (slug === null) delete eff[key];
    else eff[key] = slug;
  }
  return eff;
}

// ---------------------------------------------------------------------------
// Scraping.
// ---------------------------------------------------------------------------
let running = false;

async function runPool(items, worker) {
  let i = 0;
  const next = async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
      await sleep(DELAY);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, next));
}

async function scrapeAll(mode, manual) {
  if (running) return { running: true };
  if (mode !== 'geschaeftskunden' && mode !== 'privatkunden') {
    // Mode "none": still mark lastRun so the popup's run-spinner resolves
    // instead of polling until its timeout (des-1 contract assumption 2).
    const { aplSettings = {} } = await get(['aplSettings']);
    await set({ aplSettings: { ...aplSettings, mode, lastRun: Date.now() } });
    return { mapped: 0, scraped: 0, failed: 0 };
  }
  running = true;
  try {
    await ensureMapping();
    const eff = await effectiveMapping();
    const st = await get(['aplCache', 'aplVariantIds', 'aplSlugs']);
    const aplCache = st.aplCache || {};
    const variantIds = st.aplVariantIds || {};
    // model-slug -> modellvarianten URL (from the sitemap list we already store).
    const slugToUrl = {};
    for (const u of st.aplSlugs || []) {
      const p = u.split('/').filter(Boolean);
      if (p[p.length - 1] === 'modellvarianten') slugToUrl[p[p.length - 2]] = u;
    }
    const now = Date.now();
    const jobs = Object.entries(eff).filter(([key, slug]) => {
      if (manual) return true;
      const cached = aplCache[slug + '|' + mode];
      return !cached || now - cached.fetchedAt >= DAY;
    });

    let scraped = 0;
    let failed = 0;
    let lastError = null;
    let fetched = 0;

    await runPool(jobs, async ([key, slug]) => {
      const record = (price) => {
        aplCache[slug + '|' + mode] = { fetchedAt: Date.now(), ...price };
        scraped++;
      };
      // Resolve the numeric VarianteID (getPreisliste needs it; model slugs
      // alone either 500 or hit the wrong vehicle), then fetch the price.
      const run = async () => {
        let id = variantIds[slug];
        if (!id) {
          const page = slugToUrl[slug];
          if (!page) throw new Error('no modellvarianten url for ' + slug);
          const res = await fetch(page, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
          if (!res.ok) throw new Error('variante HTTP ' + res.status);
          const html = await res.text();
          id = (html.match(/FzgBlock-infos" data-id="(\d+)"/) || [])[1];
          if (!id) throw new Error('no variant id on ' + slug);
          variantIds[slug] = id;
        }
        const price = await APLScraper.fetchPrices(id, mode);
        if (price) record(price);
        else failed++;
      };
      try {
        await run();
      } catch (e) {
        if (e && e.status === 429) {
          await sleep(2000); // politeness on rate limit, retry once
          try { await run(); } catch (e2) {
            failed++;
            lastError = (e2 && e2.message) || String(e2);
          }
        } else {
          failed++;
          lastError = (e && e.message) || String(e);
        }
      }
      // Flush periodically so a killed event page doesn't lose a long run.
      if (++fetched % 8 === 0) await set({ aplCache, aplVariantIds: variantIds });
    });

    await set({ aplCache, aplVariantIds: variantIds });
    const stats = { mapped: Object.keys(eff).length, scraped, failed, lastError };
    const { aplSettings = {} } = await get(['aplSettings']);
    await set({ aplSettings: { ...aplSettings, mode, lastRun: Date.now(), stats } });
    return { mapped: stats.mapped, scraped, failed };
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------
// Popup message API.
// ---------------------------------------------------------------------------
async function getState() {
  await ensureMapping();
  const st = await get(['aplSettings', 'aplMapping', 'aplOverrides', 'aplCandidates', 'aplVehicles', 'aplSlugs', 'aplCache']);
  const eff = { ...(st.aplMapping || {}) };
  for (const [k, v] of Object.entries(st.aplOverrides || {})) {
    if (v === null) delete eff[k];
    else eff[k] = v;
  }
  const aplMakes = new Set();
  for (const u of st.aplSlugs || []) {
    const parts = u.split('/').filter(Boolean);
    if (parts[parts.length - 1] === 'modellvarianten') aplMakes.add(parts[parts.length - 3]);
  }
  const overrides = st.aplOverrides || {};
  const unmatched = [];
  for (const v of st.aplVehicles || []) {
    const key = v.make + '|' + v.model;
    if (eff[key] !== undefined) continue;
    if (overrides[key] === null) continue; // explicitly skipped by user
    unmatched.push({
      key,
      make: v.make,
      model: v.model,
      candidates: (st.aplCandidates || {})[key] || [],
      hasMake: aplMakes.has(APLMatcher.aplMakeSlug(v.make)),
    });
  }
  return {
    settings: st.aplSettings || { mode: 'none', lastRun: null, stats: { mapped: 0, scraped: 0, failed: 0, lastError: null } },
    mappingCount: Object.keys(eff).length,
    cacheCount: Object.keys(st.aplCache || {}).length,
    unmatched,
  };
}

browser.runtime.onMessage.addListener(async (msg) => {
  try {
    switch (msg && msg.type) {
      case 'getState':
        return await getState();
      case 'run': {
        const { aplSettings = {} } = await get(['aplSettings']);
        return await scrapeAll(aplSettings.mode || 'none', msg.manual === true);
      }
      case 'setMode': {
        const { aplSettings = {} } = await get(['aplSettings']);
        await set({ aplSettings: { ...aplSettings, mode: msg.mode } });
        return { ok: true };
      }
      case 'setOverride': {
        const { aplOverrides = {} } = await get(['aplOverrides']);
        // null value = explicit skip (stored, not deleted - deleting would let
        // the auto-match or the unmatched list claim the vehicle again).
        aplOverrides[msg.key] = msg.slug;
        await set({ aplOverrides });
        return { ok: true };
      }
      case 'clearCache':
        await browser.storage.local.remove('aplCache');
        return { ok: true };
      default:
        return { error: 'unknown:' + (msg && msg.type) };
    }
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
});

// ---------------------------------------------------------------------------
// Init + alarms.
// ---------------------------------------------------------------------------
async function init() {
  const { aplSettings } = await get(['aplSettings']);
  if (!aplSettings) {
    await set({ aplSettings: { mode: 'none', lastRun: null, stats: { mapped: 0, scraped: 0, failed: 0, lastError: null } } });
  }
  browser.alarms.create('refresh', { periodInMinutes: 60 });
}

browser.runtime.onInstalled.addListener(() => ensureMapping().catch(console.error));
browser.runtime.onStartup.addListener(() => ensureMapping().catch(console.error));
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'refresh' || running) return;
  const { aplSettings = {} } = await get(['aplSettings']);
  const mode = aplSettings.mode || 'none';
  if (mode !== 'none') await scrapeAll(mode, false);
});

init().catch(console.error);
