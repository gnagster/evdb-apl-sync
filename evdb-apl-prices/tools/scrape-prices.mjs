// Nightly APL Privatkunden scrape -> apl-prices.json (consumed by the bookmarklet).
// Lives in gnagster/evdb-apl-sync (evdb-apl-prices/tools/).
// Usage: node tools/scrape-prices.mjs [maxVehicles]   (maxVehicles = quick smoke test)
'use strict';
import { readFileSync, writeFileSync } from 'node:fs';
import APLMatcher from '../matcher.js';
import APLScraper from '../scraper.js';

const UA = APLScraper.UA;
const MAX = Number(process.argv[2]) || Infinity;
const CONCURRENCY = Number(process.env.APL_CONCURRENCY) || 3;
const DELAY = Number(process.env.APL_DELAY) || 300;
const CONSEC_FAIL_ABORT = 25; // stop early if APL starts bot-blocking us
const PREV_JSON_URL = 'https://raw.githubusercontent.com/gnagster/evdb-apl-sync/main/evdb-apl-prices/apl-prices.json';
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
const parseVariantLines = (page) => {
  const variants = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g;
  let m;
  while ((m = re.exec(page))) {
    const name = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const id = (m[2].match(/FzgBlock-infos" data-id="(\d+)"/) || [])[1];
    const url = (m[2].match(/href="(\/neuwagen\/[^"]+)"/) || [])[1];
    if (id && !/bewertung/i.test(name)) variants.push({ id, name, url: url || null });
  }
  return variants;
};

const parseNum = (s) => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
};

async function main() {
  const [aplSlugs, vehicles] = await Promise.all([
    (async () => {
      const xml = await fetchText('https://www.apl.de/sitemap.xml', 'application/xml,text/xml,*/*');
      return [...xml.matchAll(/<loc>\s*([^<]*\/neuwagen\/[^<]*?\/modellvarianten\/)\s*<\/loc>/gi)].map((m) => m[1]);
    })(),
    (async () => {
      const html = await fetchText('https://ev-database.org/', 'text/html');
      const out = [];
      for (const chunk of String(html).split('<div class="list-item" data-jplist-item>').slice(1)) {
        if (!/class="availability current"/.test(chunk)) continue; // nur bestellbar
        const title = chunk.match(/class="title">([\s\S]*?)<\/a>/);
        if (!title) continue;
        const make = (title[1].match(/<span class="[a-z0-9_]+">([^<]*)<\/span>/) || [])[1];
        const modelRaw = (title[1].match(/class="model">([\s\S]*?)<\/span>/) || [])[1];
        const model = modelRaw ? modelRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
        const shape = (chunk.match(/class="shape-([a-z]+) hidden"/) || [])[1];
        if (make && model) out.push({ make: make.trim(), model, shape });
      }
      return out;
    })(),
  ]);

  const paths = aplSlugs.map((u) => new URL(u).pathname);
  const built = APLMatcher.buildMapping(vehicles, paths); // 'Make|Model' -> apl slug (+ confidence/lowConfidence)
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
  for (const [key, slug] of Object.entries(overrides)) {
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
  if (overriddenCount) console.log('Overrides applied: ' + overriddenCount + (overrideSkipped ? ' (' + overrideSkipped + ' skipped)' : ''));

  // group jobs per slug so battery-size ranks are computed across all variants
  const slugJobs = new Map();
  for (const [key, slug] of Object.entries(mapping).slice(0, MAX)) {
    if (!slugToUrl[slug]) continue;
    if (!slugJobs.has(slug)) slugJobs.set(slug, { url: slugToUrl[slug], keys: [] });
    slugJobs.get(slug).keys.push(key);
  }
  const jobs = [...slugJobs.entries()].map(([slug, v]) => ({ slug, ...v }));

  const prices = {};
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
    let variants = cachedLines(job.slug);
    if (!variants) {
      const page = await fetchText(job.url, 'text/html');
      variants = parseVariantLines(page);
      if (!variants.length) throw new Error('no variant id');
      setCachedLines(job.slug, variants);
    }
    const lines = variants.map((v) => v.id);

    // line id -> cached fetchOffers result, else one POST (cached on success).
    const lineCache = new Map();
    const getLine = (id) => {
      if (!lineCache.has(id)) {
        const hit = cachedLine(id);
        lineCache.set(
          id,
          hit
            ? Promise.resolve(hit)
            : APLScraper.fetchOffers(id).then((r) => { setCachedLine(id, r); return r; })
        );
      }
      return lineCache.get(id);
    };

    // Per-variant prices: scrape the identified trim line for keys whose model
    // name names one of the page's trims.
    const matched = new Map(); // key -> matched variant
    for (const k of job.keys) {
      const v = APLMatcher.matchVariant(k.split('|')[1], variants);
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
      const m = k.split('|')[1];
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
        const pick = APLMatcher.pickMotor(k.split('|')[1], motors);
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

    const batteries = job.keys.map(batteryOf).filter((b) => b !== null).sort((a, b) => a - b);

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
      const b = batteryOf(k);
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

  console.log('Mapped ' + Object.keys(mapping).length + ' vehicles (' + jobs.length + ' APL models), scraping Privatkunden…');
  await runPool();

  if (aborted) { console.error('Incomplete run - apl-prices.json not touched.'); process.exit(1); }

  if (failures.length) {
    console.log('Failures by reason:');
    for (const [r, n] of Object.entries(cats).sort((a, b) => b[1] - a[1])) console.log('  ' + n + '\t' + r);
    const makes = {};
    for (const f of failures) { const m = (f.match(/^([^|]+)\|/) || [])[1]; if (m) makes[m] = (makes[m] || 0) + 1; }
    console.log('Top failure makes: ' + Object.entries(makes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m, n]) => m + ':' + n).join(', '));
  }

  // Never overwrite a good dataset with a bot-blocked/partial run.
  try {
    const prev = await (await fetch(PREV_JSON_URL)).json();
    const floor = Math.max(50, (prev.count || 0) * 0.5);
    if (scraped < floor) { console.error('Coverage drop (' + scraped + ' < ' + floor + ') - keeping existing file.'); process.exit(1); }
  } catch { /* first run / fetch hiccup -> write anyway */ }

  // lowConfidence from the matcher, minus anything overridden (slug overrides
  // get confidence 1.0; null overrides aren't in prices anyway) and minus keys
  // that failed to scrape.
  const overridden = new Set(Object.keys(overrides));
  const lowConfidence = Array.isArray(built.lowConfidence)
    ? built.lowConfidence.filter((k) => !overridden.has(k) && Object.prototype.hasOwnProperty.call(prices, k))
    : [];
  const out = { generatedAt: new Date().toISOString(), source: 'privatkunden', count: scraped, prices, lowConfidence };
  writeFileSync('apl-prices.json', JSON.stringify(out, null, 2));
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log('Wrote apl-prices.json with ' + scraped + ' prices (' + failCount() + ' failed).');
}

main().catch((e) => { console.error(e); process.exit(1); });
