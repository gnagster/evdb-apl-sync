// Nightly APL Privatkunden scrape -> apl-prices.json (consumed by the bookmarklet).
// Lives in gnagster/evdb-apl-sync (tools/).
// Usage: node tools/scrape-prices.mjs [maxVehicles]   (maxVehicles = quick smoke test)
'use strict';
import { readFileSync, writeFileSync } from 'node:fs';
import APLMatcher from '../matcher.js';
import APLScraper from '../scraper.js';
import Dashboard from '../dashboard/core.js';
import EVDB from '../dashboard/evdb.js';
import { createHash } from 'node:crypto';

const UA = APLScraper.UA;
const MODE = process.env.APL_MODE || 'full';
const TARGET = process.env.APL_TARGET || '';
if (!['full', 'vehicle', 'offer', 'catalogue', 'corrections'].includes(MODE)) throw new Error('Unknown scrape mode');
let corrections = Dashboard.validate(JSON.parse(readFileSync('tools/dashboard-overrides.json', 'utf8')));
const correctionText = readFileSync('tools/dashboard-overrides.json', 'utf8');
let previous = null;
try { previous = JSON.parse(readFileSync('apl-prices.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let basePrices = previous ? Dashboard.rawPrices(previous) : {};
const forceLines = new Set();
const touched = new Set();
const originalCache = JSON.parse(readFileSync('tools/scrape-cache.json', 'utf8'));
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const MAX = Number(process.argv[2]) || Infinity;
const CONCURRENCY = Number(process.env.APL_CONCURRENCY) || 3;
const DELAY = Number(process.env.APL_DELAY) || 300;
const CONSEC_FAIL_ABORT = 25; // stop early if APL starts bot-blocking us
const MAX_LINES = 6; // cap on variant lines probed per model (base + top trims)
const TAG_ORDER = ['für Privatkunden', 'für Geschäftskunden', 'für Freiberufler'];
// Persistent cache so already-wired lines/specs are not re-scraped every day.
const CACHE_PATH = 'tools/scrape-cache.json';
const PRICE_TTL_H = Number(process.env.APL_PRICE_TTL_H) || 72; // per-line prices/offers freshness
const STRUCTURE_TTL_H = Number(process.env.APL_STRUCTURE_TTL_H) || 168; // slug -> variant lines freshness
// 0..1 matcher confidence per 'Make|Model', default 0.8 when the matcher lane
// hasn't added confidence yet.
const confOf = (key, built) => (built.confidence && built.confidence[key]) || 0.8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Scrape cache -----------------------------------------------------------
// Committed alongside apl-prices.json so nightly runs reuse what they already
// wired: line-level prices/offers (refreshed every PRICE_TTL_H), slug -> variant
// lines (structure, every STRUCTURE_TTL_H), and motor specs (permanent - specs
// are static per motor id). The key set is ALWAYS re-derived from the fresh
// evdb list each run, so sold-out cars disappear and new ones are fetched
// immediately; only already-known APL data is skipped.
let cache = { slugLines: {}, lineData: {}, motorSpecs: {} };
try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const fresh = (t, ttlH) => !!t && Date.now() - new Date(t).getTime() < ttlH * 3600 * 1000;
const structure = () => cache.slugLines || (cache.slugLines = {});
const cachedLines = (slug) => (fresh(structure()[slug] && structure()[slug].fetchedAt, STRUCTURE_TTL_H) ? structure()[slug].lines : null);
const setCachedLines = (slug, lines) => { structure()[slug] = { fetchedAt: new Date().toISOString(), lines }; };
const lineData = () => cache.lineData || (cache.lineData = {});
const cachedLine = (id) => (fresh(lineData()[id] && lineData()[id].fetchedAt, PRICE_TTL_H) ? lineData()[id].data : null);
const setCachedLine = (id, data) => { lineData()[id] = { fetchedAt: new Date().toISOString(), data }; };

async function fetchText(url, accept = '*/*') {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept } });
  if (!res.ok) { const e = new Error('HTTP ' + res.status + ' ' + url); e.status = res.status; throw e; }
  return res.text();
}

// 'Make|Model' -> battery size in kWh, or null (no battery info in the name).
const batteryOf = (key) => {
  const m = key.match(/(\d+(?:\.\d+)?)\s*kWh/i);
  return m ? parseFloat(m[1]) : null;
};

// Modellvarianten page -> variant lines [{id, name, url}] in page order (skips
// review blocks). name is the trim label ("VW ID.Buzz Pure", "Kia EV9 GT-line")
// used by matchVariant for per-variant pricing; url is the trim detail page
// ("/neuwagen/nissan/ariya/advance/") whose item-motor blocks carry the specs.
const parseVariantLines = APLScraper.parseVariantLines;

const parseNum = (s) => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
};

async function main() {
  const [aplSlugs, vehicles] = MODE === 'full' ? await Promise.all([
    (async () => {
      const html = await fetchText('https://www.apl.de/neuwagen/', 'text/html');
      return APLScraper.parseModelUrls(html);
    })(),
    Promise.resolve(JSON.parse(readFileSync('evdb-vehicles.json', 'utf8')).vehicles),
  ]) : [Object.values(previous?.modelUrls || {}), (() => { try { return JSON.parse(readFileSync('evdb-vehicles.json', 'utf8')).vehicles; } catch (e) { if (e.code !== 'ENOENT') throw e; return previous?.vehicles || []; } })()];
  if (!aplSlugs.length || !vehicles.length) throw new Error('No APL models or EVDB vehicles found; keeping existing prices.');

  const idMode = vehicles.every((v) => v.id);
  const vehicleKey = (v) => idMode ? EVDB.key(v) : v.make + '|' + v.model;
  const nameOf = (k) => vehicles.find((v) => vehicleKey(v) === k)?.model || k.split('|')[1];
  const migration = idMode ? EVDB.migrate(corrections, vehicles) : { config: corrections, conflicts: [] };
  corrections = migration.config;
  if (idMode && previous && !previous.pricesByEvdbId) basePrices = EVDB.idPrices(previous, vehicles, true);
  for (const k of Object.keys(corrections.mapping)) if (idMode && k.startsWith('evdb:') && !vehicles.some((v) => vehicleKey(v) === k)) throw Error('Unbekannte EVDB-ID in Korrektur: ' + k);
  const paths = aplSlugs.map((u) => new URL(u).pathname);
  const built = APLMatcher.buildMapping(vehicles.filter((v) => !v.status || v.status === 'current'), paths); // 'Make|Model' -> apl slug (+ confidence/lowConfidence)
  if (idMode) {
    const oldMapping = built.mapping, oldConfidence = built.confidence;
    built.mapping = {};built.confidence = {};
    for (const v of vehicles.filter((v) => v.status === 'current')) {
      const oldKey = v.make + '|' + v.model, k = vehicleKey(v);
      if (oldMapping[oldKey]) { built.mapping[k] = oldMapping[oldKey];built.confidence[k] = oldConfidence[oldKey]; }
    }
    built.lowConfidence = Object.keys(built.mapping).filter((k) => built.confidence[k] < .85);
  }
  const { mapping, unmatched, candidates } = built;
  const slugToUrl = {};
  for (const u of aplSlugs) {
    const p = u.split('/').filter(Boolean);
    if (p[p.length - 1] === 'modellvarianten') slugToUrl[p[p.length - 2]] = u;
  }

  // Manual lane corrections (written by the low-confidence review agent, never
  // by this pipeline): {"Make|Model": "apl-slug" | null}. Applied AFTER the
  // matcher: a slug redirects the scrape target with confidence 1.0; null
  // force-skips the key. Overrides redirect WHICH slug is scraped; within the
  // slug, per-variant pricing (below) still applies.
  let overrides = {};
  try {
    overrides = JSON.parse(readFileSync('tools/overrides.json', 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // missing file is fine
  }
  let overriddenCount = 0, overrideSkipped = 0;
  for (const [legacyKey, slug] of Object.entries(overrides)) {
    const matches = vehicles.filter((v) => v.make + '|' + v.model === legacyKey);
    if (idMode && matches.length !== 1) { migration.conflicts.push(legacyKey);continue; }
    const key = idMode ? vehicleKey(matches[0]) : legacyKey;
    const i = unmatched.findIndex((u) => u.key === key);
    if (i >= 0) unmatched.splice(i, 1);
    delete candidates[key];
    if (slug == null) {
      delete mapping[key]; // never scrape this key
      delete built.confidence[key];
      unmatched.push({ make: key.split('|')[0] || '', model: key.split('|')[1] || '', key, override: null });
      overriddenCount++;
    } else {
      if (!slugToUrl[slug]) { console.error('Override ' + key + ' -> unknown slug "' + slug + '" (ignored)'); overrideSkipped++; continue; }
      mapping[key] = slug;
      built.confidence[key] = 1.0;
      overriddenCount++;
    }
  }
  for (const [key, m] of Object.entries(corrections.mapping)) {
    if (idMode && !key.startsWith('evdb:')) continue;
    if (m === null || m.evdbOnly) { delete mapping[key]; continue; }
    const slug = m.slug || m.base?.slug || mapping[key];
    if (!slug || !slugToUrl[slug]) throw new Error('Unknown APL model for ' + key);
    mapping[key] = slug;
    built.confidence[key] = 1;
  }
  const ensureLines = async (slug, force = false) => {
    if (!slugToUrl[slug]) throw new Error('Unknown APL model: ' + slug);
    let lines = force ? null : cachedLines(slug);
    if (!lines) {
      lines = parseVariantLines(await fetchText(slugToUrl[slug], 'text/html'));
      if (!lines.length) throw new Error('No variants for ' + slug);
      setCachedLines(slug, lines);
    }
    return lines;
  };
  const fetchLine = async (slug, variant, force = false) => {
    let data = !force && cachedLine(variant.id);
    // Old cache entries have no tariff identity and must be fetched once.
    if (data && Object.values(data.offers || {}).flat().some((o) => o.tariffId === undefined)) data = null;
    if (!data) {
      data = await APLScraper.fetchOffers(variant.id);
      setCachedLine(variant.id, data);
      touched.add(variant.id);
    }
    const ids = Object.keys(data.offers || {});
    if (variant.url && (force || ids.some((id) => !cache.motorSpecs[id]))) {
      try { Object.assign(cache.motorSpecs, APLScraper.parseMotorSpecs(await fetchText('https://www.apl.de' + variant.url, 'text/html'))); }
      catch (e) { console.warn('Motor specs unavailable for ' + variant.id + ': ' + e.message); }
    }
    const out = Dashboard.clone(data);
    for (const [motor, offers] of Object.entries(out.offers || {})) {
      for (const o of offers) o.source = { slug, variantId: variant.id, motorId: motor, tariffId: o.tariffId,
        variantName: variant.name, url: variant.url, ...(cache.motorSpecs[motor] || {}), fetchedAt: cache.lineData[variant.id].fetchedAt };
      if (out.byMotor[motor]) out.byMotor[motor].source = offers.find((o) => o.tag === TAG_ORDER[0])?.source;
    }
    return out;
  };
  const ensureSource = async (ref, force = false) => {
    Dashboard.validateSource(ref);
    const variants = await ensureLines(ref.slug, force);
    const v = variants.find((v) => v.id === ref.variantId);
    if (!v) throw new Error('Selected APL variant disappeared: ' + Dashboard.sourceId(ref));
    return fetchLine(ref.slug, v, force);
  };
  let selectedSlugs = null;
  const changedMappingKeys = new Set();
  if (MODE === 'vehicle') {
    if (!mapping[TARGET]) throw new Error('Unknown or excluded vehicle: ' + TARGET);
    selectedSlugs = new Set([mapping[TARGET]]);
    for (const ref of Dashboard.references(basePrices[TARGET])) selectedSlugs.add(ref.slug);
    for (const ref of [corrections.mapping[TARGET]?.base, ...Object.values(corrections.mapping[TARGET]?.offers || {})].filter(Boolean)) selectedSlugs.add(ref.slug);
    for (const slug of selectedSlugs) {
      for (const v of await ensureLines(slug, true)) forceLines.add(v.id);
    }
  } else if (MODE === 'corrections') {
    const old = previous.appliedOverrides?.mapping || {};
    const keys = new Set([...Object.keys(old), ...Object.keys(corrections.mapping)]);
    selectedSlugs = new Set();
    for (const key of keys) {
      if (JSON.stringify(old[key]) === JSON.stringify(corrections.mapping[key])) continue;
      changedMappingKeys.add(key);
      if (mapping[key]) selectedSlugs.add(mapping[key]);
      for (const ref of [corrections.mapping[key]?.base, ...Object.values(corrections.mapping[key]?.offers || {})].filter(Boolean)) selectedSlugs.add(ref.slug);
    }
  }
  if (overriddenCount) console.log('Overrides applied: ' + overriddenCount + (overrideSkipped ? ' (' + overrideSkipped + ' skipped)' : ''));

  // group jobs per slug so battery-size ranks are computed across all variants
  const slugJobs = new Map();
  for (const [key, slug] of Object.entries(mapping).slice(0, MAX)) {
    if (!slugToUrl[slug]) continue;
    if (!slugJobs.has(slug)) slugJobs.set(slug, { url: slugToUrl[slug], keys: [] });
    slugJobs.get(slug).keys.push(key);
  }
  const jobs = [...slugJobs.entries()].filter(([slug]) => !selectedSlugs || selectedSlugs.has(slug)).map(([slug, v]) => ({ slug, ...v }));

  let prices = {};
  const failures = []; // 'key -> slug [reason]' for diagnosis
  const cats = {};
  const failCount = () => Object.values(cats).reduce((a, b) => a + b, 0);
  let scraped = 0, consecFail = 0, fetched = 0, aborted = false;

  const recordFail = (key, slug, reason) => {
    cats[reason] = (cats[reason] || 0) + 1;
    failures.push(key + ' -> ' + slug + ' [' + reason + ']');
  };
  const failAll = (job, reason) => { for (const k of job.keys) recordFail(k, job.slug, reason); };

  // One APL modellvarianten page + its price lists; assigns every evdb variant
  // of the slug. Per-variant: when an evdb model name carries a trim the page
  // names (matchVariant - "Taycan Turbo S", "EV9 ... GT-Line", "ID.Buzz Pure"),
  // that line is scraped and its own price/offers are used. Everything else
  // falls back to the previous behaviour: battery-split models match evdb kWh
  // rank (ascending) to the APL motor price rank (ascending, cheapest per
  // motor across variant lines); otherwise the base variant + base motor.
  // fetchOffers returns BOTH the PK per-motor map (battery matching) and every
  // classified offer per motor, so a single POST per line covers both outputs.
  const offersFrom = (r) => {
    const best = new Map(); // tag -> { offer, num }, cheapest endpreis wins
    for (const list of Object.values(r.offers || {})) {
      for (const o of list) {
        const v = parseNum(o.endpreis);
        if (v === null) continue;
        const cur = best.get(o.tag);
        if (!cur || v < cur.num) best.set(o.tag, { offer: o, num: v });
      }
    }
    return TAG_ORDER.map((t) => (best.get(t) || {}).offer).filter(Boolean);
  };
  const scrapeSlug = async (job) => {
    const variants = await ensureLines(job.slug);
    const lines = variants.map((v) => v.id);
    const lineCache = new Map();
    const getLine = (id) => {
      if (!lineCache.has(id)) {
        const variant = variants.find((v) => v.id === id);
        lineCache.set(id, fetchLine(job.slug, variant, forceLines.has(id)));
      }
      return lineCache.get(id);
    };

    // Per-variant prices: scrape the identified trim line for keys whose model
    // name names one of the page's trims.
    const matched = new Map(); // key -> matched variant
    for (const k of job.keys) {
      const v = APLMatcher.matchVariant(nameOf(k), variants);
      if (v) matched.set(k, v);
    }
    for (const [k, v] of matched) {
      let r;
      try { r = await getLine(v.id); } catch (e) { recordFail(k, job.slug, 'no offers'); continue; }
      const firstPk = r.byMotor[Object.keys(r.byMotor)[0]];
      if (!firstPk) { recordFail(k, job.slug, 'no PK price'); continue; }
      prices[k] = { slug: job.slug, confidence: confOf(k, built), ...firstPk, offers: offersFrom(r) };
      scraped++;
    }
    if (matched.size) job.keys = job.keys.filter((k) => !matched.has(k));
    if (!job.keys.length) return;

    // Spec lane: multi-variant slugs whose names carry battery/kW. The
    // battery-rank fallback below collapses variants that share a battery
    // (Ariya 87kWh FWD vs e-4ORCE 87kWh both land on the cheapest motor);
    // instead pick the motor whose (kWh, kW) matches the name (pickMotor).
    // Motor specs come from the trim detail pages and are cached permanently.
    const specKeys = job.keys.filter((k) => {
      const m = nameOf(k);
      return APLMatcher.specKwhOf(m) != null || APLMatcher.specKwOf(m) != null;
    });
    if (specKeys.length && job.keys.length > 1) {
      const cands = new Map(); // motorId -> { price, num, offers }
      for (const v of variants.slice(0, MAX_LINES)) {
        let r;
        try { r = await getLine(v.id); } catch (e) { continue; } // line failure -> fallback path
        for (const [motor, price] of Object.entries(r.byMotor)) {
          const num = parseNum(price.endpreis);
          if (num === null) continue;
          const cur = cands.get(motor);
          if (!cur || num < cur.num) cands.set(motor, { price, num, offers: r.offers[motor] || [] });
        }
      }
      // Fetch specs only for motors we still miss (permanent cache: once a
      // motor's specs are known they never need a detail page again).
      for (const v of variants.slice(0, MAX_LINES)) {
        if (!v.url) continue;
        if (![...cands.keys()].some((id) => !cache.motorSpecs[id])) break;
        try {
          const specPage = await fetchText('https://www.apl.de' + v.url, 'text/html');
          Object.assign(cache.motorSpecs, APLScraper.parseMotorSpecs(specPage));
        } catch (e) { /* specs unavailable -> those keys fall back */ }
      }
      const specMatched = new Set();
      for (const k of specKeys) {
        const motors = [...cands].map(([id, cand]) => ({ id, num: cand.num, ...(cache.motorSpecs[id] || {}) }));
        const pick = APLMatcher.pickMotor(nameOf(k), motors);
        if (pick && cands.has(pick)) {
          const cand = cands.get(pick);
          // Same offer ordering as the other lanes (PK, GK, Freiberufler).
          const offers = TAG_ORDER.map((t) => cand.offers.find((o) => o.tag === t)).filter(Boolean);
          prices[k] = { slug: job.slug, confidence: confOf(k, built), ...cand.price, offers };
          specMatched.add(k);
          scraped++;
        }
      }
      if (specMatched.size) job.keys = job.keys.filter((k) => !specMatched.has(k));
    }
    if (!job.keys.length) return;

    const batteries = job.keys.map((k) => batteryOf(nameOf(k))).filter((b) => b !== null).sort((a, b) => a - b);

    const byMotor = new Map(); // motorId -> { price, num } (PK only)
    const offers = new Map(); // tag -> { offer, num }, cheapest endpreis wins
    const offersOut = () => TAG_ORDER.map((t) => (offers.get(t) || {}).offer).filter(Boolean);
    const mergeLine = (r) => {
      for (const [motor, p] of Object.entries(r.byMotor)) {
        const v = parseNum(p.endpreis);
        if (v === null) continue;
        const cur = byMotor.get(motor);
        if (!cur || v < cur.num) byMotor.set(motor, { price: p, num: v });
      }
      for (const list of Object.values(r.offers)) {
        for (const o of list) {
          const v = parseNum(o.endpreis);
          if (v === null) continue;
          const cur = offers.get(o.tag);
          if (!cur || v < cur.num) offers.set(o.tag, { offer: o, num: v });
        }
      }
    };

    if (batteries.length < 2) {
      // single battery info (or none): base variant, base motor (previous
      // behaviour - first PK block == first byMotor entry), all offers merged.
      const r = await getLine(lines[0]);
      const firstPk = r.byMotor[Object.keys(r.byMotor)[0]];
      if (!firstPk) throw new Error('no PK price');
      mergeLine(r);
      for (const k of job.keys) prices[k] = { slug: job.slug, confidence: confOf(k, built), ...firstPk, offers: offersOut() };
      scraped += job.keys.length;
      return;
    }

    // battery path: PK price per motor + all-tag offers, cheapest across lines
    let gotSplit = false;
    for (let li = 0; li < Math.min(lines.length, MAX_LINES); li++) {
      const r = await getLine(lines[li]);
      if (!r) continue;
      mergeLine(r);
      if (byMotor.size >= 2) gotSplit = true;
      if (gotSplit && li >= 1) break; // base + a battery-split line suffice
    }
    // distinct motor prices, ascending (dedupe: APL lists the same powertrain
    // under several motor ids with identical prices - e.g. Leapmotor C10 3655/3656)
    const motors = [...byMotor.values()].sort((a, b) => a.num - b.num)
      .filter((m, i, arr) => i === 0 || m.num !== arr[i - 1].num);
    if (!motors.length) throw new Error('no PK price');

    for (const k of job.keys) {
      const b = batteryOf(nameOf(k));
      let chosen = motors[0].price; // no battery info -> base motor
      if (b !== null) {
        const rank = batteries.indexOf(b); // ascending order
        if (rank >= 0) chosen = motors[Math.min(rank, motors.length - 1)].price;
      }
      prices[k] = { slug: job.slug, confidence: confOf(k, built), ...chosen, offers: offersOut() };
    }
    scraped += job.keys.length;
  };

  const runPool = async () => {
    let i = 0;
    const next = async () => {
      while (!aborted && i < jobs.length) {
        const job = jobs[i++];
        const once = async () => {
          try {
            await scrapeSlug(job);
            consecFail = 0;
            return true;
          } catch (e) {
            const reason = e && e.status ? 'HTTP ' + e.status : (e && e.message) || String(e);
            if (e && e.status === 429) {
              await sleep(2000); // politeness on rate limit, retry once
              try { await scrapeSlug(job); consecFail = 0; return true; }
              catch { failAll(job, reason); }
            } else {
              failAll(job, reason);
            }
            consecFail++;
            return false;
          }
        };
        if (!(await once()) && consecFail >= CONSEC_FAIL_ABORT) {
          console.error('Aborting: ' + consecFail + ' consecutive failures');
          aborted = true;
          return;
        }
        if (++fetched % 50 === 0) console.log('  ' + fetched + '/' + jobs.length + ' slugs (ok=' + scraped + ', fail=' + failCount() + ')');
        await sleep(DELAY);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, next));
  };

  const replaceSourceValues = (ids, sourcePrices = basePrices) => {
    for (const key of Dashboard.affected(sourcePrices, ids)) {
      const entry = Dashboard.clone(sourcePrices[key]);
      if (entry.source && ids.has(entry.source.variantId)) {
        const fresh = Dashboard.sourceOffer(entry.source, TAG_ORDER[0], cache);
        for (const f of Dashboard.FIELDS) entry[f] = fresh[f];
        entry.source = fresh.source;
      }
      entry.offers = (entry.offers || []).map((o) => o.source && ids.has(o.source.variantId)
        ? Dashboard.sourceOffer(o.source, o.tag, cache) : o);
      prices[key] = entry;
    }
  };
  if (MODE === 'catalogue') {
    const variants = await ensureLines(TARGET, true);
    for (const v of variants) {
      // Variants without classified offers remain visible, but cannot be assigned.
      await fetchLine(TARGET, v, true);
      await sleep(DELAY);
    }
    prices = Dashboard.clone(basePrices);
    replaceSourceValues(touched);
  } else if (MODE === 'offer') {
    const ref = JSON.parse(TARGET);
    await ensureSource(ref, true);
    Dashboard.sourceOffer(ref, ref.tag || TAG_ORDER[0], cache);
    prices = Dashboard.clone(basePrices);
    replaceSourceValues(new Set([ref.variantId]));
  } else {
    console.log('Mapped ' + Object.keys(mapping).length + ' vehicles (' + jobs.length + ' APL models), scraping Privatkunden…');
    await runPool();
    if (failures.length) {
      console.log('Failures by reason:', cats);
      console.log(failures.slice(0, 20).join('\n'));
    }
    if (aborted) throw new Error('Incomplete run; existing prices kept.');
    if (MODE === 'full') {
      const active = new Set(vehicles.filter((v) => !v.status || v.status === 'current').map(vehicleKey));
      for (const [key, old] of Object.entries(basePrices)) {
        if (!prices[key] && active.has(key) && corrections.mapping[key] !== null) {
          prices[key] = { ...old, stale: true, lastError: 'Quelle konnte nicht aktualisiert werden. Letzter guter Preis bleibt erhalten.' };
        }
      }
      const floor = Math.max(50, (previous?.count || 0) * 0.5);
      if (scraped < floor) throw new Error('Coverage drop; existing prices kept.');
    } else {
      const expected = jobs.flatMap((j) => [...slugJobs.get(j.slug).keys]).filter((key) => basePrices[key] || key === TARGET);
      const failed = expected.filter((key) => !prices[key] && !corrections.mapping[key]?.base);
      if (failed.length) throw new Error('Targeted scrape incomplete: ' + failed.join(', '));
      const updated = prices;
      prices = Dashboard.clone(basePrices);
      replaceSourceValues(touched);
      Object.assign(prices, updated);
    }
  }
  // Resolve pinned sources explicitly; never fall back if a pinned source vanishes.
  for (const [key, m] of Object.entries(corrections.mapping)) {
    if (!m || (idMode && !key.startsWith('evdb:'))) continue;
    const refs = [m.base, ...Object.values(m.offers || {})].filter(Boolean);
    for (const ref of refs) {
      if (MODE === 'full' || !cache.lineData[ref.variantId] || changedMappingKeys.has(key) || (forceLines.has(ref.variantId) && !touched.has(ref.variantId))) {
        await ensureSource(ref, forceLines.has(ref.variantId) && !touched.has(ref.variantId));
      }
    }
    if (!prices[key] && m.base) {
      prices[key] = { slug: m.base.slug, confidence: 1, offers: [] };
    }
  }
  if (MODE !== 'full') replaceSourceValues(touched, prices);
  const activeCorrections = idMode ? Object.fromEntries(['mapping','prices'].map((section) => [section, Object.fromEntries(Object.entries(corrections[section]).filter(([k]) => k.startsWith('evdb:')))])) : corrections;
  prices = Dashboard.applyMappings(prices, activeCorrections, cache);
  const applied = Dashboard.applyPrices(prices, activeCorrections);
  prices = applied.prices;
  for (const warning of applied.warnings) console.warn(warning);
  // lowConfidence from the matcher, minus anything overridden (slug overrides
  // get confidence 1.0; null overrides aren't in prices anyway) and minus keys
  // that failed to scrape.
  const overridden = new Set(Object.keys(overrides));
  const lowConfidence = Array.isArray(built.lowConfidence)
    ? built.lowConfidence.filter((k) => !overridden.has(k) && Object.prototype.hasOwnProperty.call(prices, k))
    : [];
  const out = { generatedAt: MODE === 'corrections' ? previous.generatedAt : new Date().toISOString(),
    source: 'privatkunden', count: Object.keys(prices).length, prices, lowConfidence,
    originalPrices: applied.originalPrices, appliedOverrides: corrections,
    modelUrls: slugToUrl, vehicles, warnings: applied.warnings };
  if (idMode) {
    out.pricesByEvdbId = out.prices;out.originalPricesByEvdbId = out.originalPrices;
    out.prices = EVDB.legacy(prices, vehicles);out.originalPrices = EVDB.legacy(applied.originalPrices, vehicles);
    out.vehicles = vehicles.map(({id,make,model,shape,status}) => ({id,make,model,shape,status}));
    out.schemaVersion = 2;out.migrationConflicts = [...new Set(migration.conflicts)];
  }
  const rawOutput = Dashboard.rawPrices(out);
  const changedKeys = Object.keys({ ...basePrices, ...prices }).filter((key) => JSON.stringify(basePrices[key]) !== JSON.stringify(rawOutput[key]));
  writeFileSync('tools/scrape-result.json', JSON.stringify({ mode: MODE, correctionText, legacyOverrides: overrides,
    baseline: Object.fromEntries(changedKeys.map((key) => [key, digest(basePrices[key] || null)])),
    changedKeys, touched: [...touched], cacheBaseline: Object.fromEntries([...touched].map((id) => [id, digest(originalCache.lineData[id] || null)])) }));
  writeFileSync('apl-prices.json', JSON.stringify(out, null, 2));
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log('Wrote apl-prices.json with ' + out.count + ' prices (' + failCount() + ' failed).');
}

main().catch((e) => { console.error(e); process.exit(1); });
