// Nightly APL Privatkunden scrape -> apl-prices.json (consumed by the bookmarklet).
// Lives in gnagster/evdb-apl-sync (evdb-apl-prices/tools/).
// Usage: node tools/scrape-prices.mjs [maxVehicles]   (maxVehicles = quick smoke test)
'use strict';
import { writeFileSync } from 'node:fs';
import APLMatcher from '../matcher.js';
import APLScraper from '../scraper.js';

const UA = APLScraper.UA;
const MAX = Number(process.argv[2]) || Infinity;
const CONCURRENCY = Number(process.env.APL_CONCURRENCY) || 3;
const DELAY = Number(process.env.APL_DELAY) || 300;
const CONSEC_FAIL_ABORT = 25; // stop early if APL starts bot-blocking us
const PREV_JSON_URL = 'https://raw.githubusercontent.com/gnagster/evdb-apl-sync/main/evdb-apl-prices/apl-prices.json';
const MAX_LINES = 6; // cap on variant lines probed per model (base + top trims)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Modellvarianten page -> variant line ids in page order (skips review blocks).
const parseVariantLines = (page) => {
  const lines = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g;
  let m;
  while ((m = re.exec(page))) {
    const name = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const id = (m[2].match(/FzgBlock-infos" data-id="(\d+)"/) || [])[1];
    if (id && !/bewertung/i.test(name)) lines.push(id);
  }
  return lines;
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
  const { mapping } = APLMatcher.buildMapping(vehicles, paths); // 'Make|Model' -> apl slug
  const slugToUrl = {};
  for (const u of aplSlugs) {
    const p = u.split('/').filter(Boolean);
    if (p[p.length - 1] === 'modellvarianten') slugToUrl[p[p.length - 2]] = u;
  }

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
  // of the slug. Battery-split models match evdb kWh rank (ascending) to the
  // APL motor price rank (ascending, cheapest per motor across variant lines).
  const scrapeSlug = async (job) => {
    const page = await fetchText(job.url, 'text/html');
    const lines = parseVariantLines(page);
    if (!lines.length) throw new Error('no variant id');
    const batteries = job.keys.map(batteryOf).filter((b) => b !== null).sort((a, b) => a - b);

    if (batteries.length < 2) {
      // single battery info (or none): base variant, base motor (previous behaviour)
      const price = await APLScraper.fetchPrices(lines[0], 'privatkunden');
      if (!price) throw new Error('no PK price');
      for (const k of job.keys) prices[k] = { slug: job.slug, ...price };
      scraped += job.keys.length;
      return;
    }

    // battery path: PK price per motor, cheapest across the variant lines
    const byMotor = new Map(); // motorId -> { price, num }
    let gotSplit = false;
    for (let li = 0; li < Math.min(lines.length, MAX_LINES); li++) {
      const map = await APLScraper.fetchPKByMotor(lines[li]);
      if (!map) continue;
      for (const [motor, p] of Object.entries(map)) {
        const v = parseNum(p.endpreis);
        if (v === null) continue;
        const cur = byMotor.get(motor);
        if (!cur || v < cur.num) byMotor.set(motor, { price: p, num: v });
      }
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
      prices[k] = { slug: job.slug, ...chosen };
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

  const out = { generatedAt: new Date().toISOString(), source: 'privatkunden', count: scraped, prices };
  writeFileSync('apl-prices.json', JSON.stringify(out, null, 2));
  console.log('Wrote apl-prices.json with ' + scraped + ' prices (' + failCount() + ' failed).');
}

main().catch((e) => { console.error(e); process.exit(1); });
