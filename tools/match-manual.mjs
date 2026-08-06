// Interactive manual matcher for wrong / low-confidence evdb->APL mappings.
// Walks the matcher's unmatched + low-confidence models and lets a human
// decide each one: redirect to an APL slug, mark unmatched (null), or keep.
// Decisions are merged into tools/overrides.json, exactly what
// tools/scrape-prices.mjs applies on the next run.
// Usage (from evdb-apl-prices/): node tools/match-manual.mjs
// Preview without writing: MANUAL_DRY=1 node tools/match-manual.mjs
'use strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import APLMatcher from '../matcher.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const OVERRIDES_PATH = 'tools/overrides.json';

const fetchText = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.text();
};

// Same inputs + parsing as scrape-prices.mjs, so the review queue matches
// what the pipeline saw when it built apl-prices.json.
const load = async () => {
  const [xml, html] = await Promise.all([
    fetchText('https://www.apl.de/sitemap.xml'),
    fetchText('https://ev-database.org/'),
  ]);
  const paths = [...xml.matchAll(/<loc>\s*([^<]*\/neuwagen\/[^<]*?\/modellvarianten\/)\s*<\/loc>/gi)]
    .map((m) => new URL(m[1]).pathname);
  const vehicles = [];
  for (const chunk of String(html).split('<div class="list-item" data-jplist-item>').slice(1)) {
    if (!/class="availability current"/.test(chunk)) continue;
    const title = chunk.match(/class="title">([\s\S]*?)<\/a>/);
    if (!title) continue;
    const make = (title[1].match(/<span class="[a-z0-9_]+">([^<]*)<\/span>/) || [])[1];
    const modelRaw = (title[1].match(/class="model">([\s\S]*?)<\/span>/) || [])[1];
    const model = modelRaw ? modelRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    const shape = (chunk.match(/class="shape-([a-z]+) hidden"/) || [])[1];
    if (make && model) vehicles.push({ make: make.trim(), model, shape });
  }
  return { paths, vehicles };
};

// Top APL candidates for a model, same rule as the matcher's unmatched list.
const candidatesOf = (rawMake, model, shape, models) => {
  const cores = APLMatcher.cleanModel(rawMake, model, shape);
  return [...models]
    .map((m) => ({ m, s: Math.max(...[cores.a, cores.b, cores.c].filter(Boolean).map((c) => APLMatcher.score(m, c))) }))
    .filter((x) => x.s >= 0.4)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);
};

async function main() {
  let overrides = {};
  try { overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const { paths, vehicles } = await load();
  const built = APLMatcher.buildMapping(vehicles, paths);
  const byMake = new Map(); // apl make -> Set of model slugs
  const slugSet = new Set();
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean); // [neuwagen, make, model, modellvarianten]
    if (parts.length < 4) continue;
    slugSet.add(parts[2]);
    if (!byMake.has(parts[1])) byMake.set(parts[1], new Set());
    byMake.get(parts[1]).add(parts[2]);
  }
  const shapeOf = new Map(vehicles.map((v) => [v.make + '|' + v.model, v.shape]));

  const queue = [
    ...built.unmatched.map((u) => ({ key: u.key, conf: null, cur: null, kind: 'unmatched' })),
    ...built.lowConfidence
      .map((k) => ({ key: k, conf: built.confidence[k], cur: built.mapping[k], kind: 'low' }))
      .sort((a, b) => a.conf - b.conf),
  ].filter((x) => !(x.key in overrides)); // already decided -> skip

  if (!queue.length) { console.log('Nothing to review - all flagged keys are already overridden.'); return; }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const newOverrides = {};
  const ask = async (prompt) => { try { return (await rl.question(prompt)).trim(); } catch { return 'q'; } }; // EOF = quit

  for (let i = 0; i < queue.length; i++) {
    const { key, conf, cur, kind } = queue[i];
    const [rawMake, model] = key.split('|');
    const cands = candidatesOf(rawMake, model, shapeOf.get(key), byMake.get(APLMatcher.aplMakeSlug(rawMake)) || new Set());

    console.log('\n[' + (i + 1) + '/' + queue.length + '] ' + key + '  (' + kind + (conf != null ? ', conf ' + conf.toFixed(2) : '') + ')');
    console.log(cur ? '  currently -> ' + cur : '  no match');
    if (cands.length) cands.forEach((c, j) => console.log('  ' + (j + 1) + ') ' + c.m + '  (' + c.s.toFixed(2) + ')'));
    else console.log('  (no candidate >= 0.4)');
    console.log('  [1-6] pick candidate | <slug> custom | null = unmatched | <enter> keep | q quit');

    let decided = false;
    while (!decided) {
      const ans = (await ask('> ')).toLowerCase();
      if (!ans) decided = true; // keep as is
      else if (ans === 'q') { rl.close(); return finish(overrides, newOverrides); }
      else if (ans === 'null') { newOverrides[key] = null; decided = true; }
      else if (/^[1-9]\d*$/.test(ans)) {
        // Bare numbers mean candidate indices (APL has numeric model slugs
        // like "208"/"911" - only reachable here when no candidate matches).
        if (Number(ans) <= cands.length) { newOverrides[key] = cands[Number(ans) - 1].m; decided = true; }
        else if (slugSet.has(ans)) { newOverrides[key] = ans; decided = true; console.log('  (no candidate #' + ans + ' - accepted as APL slug "' + ans + '")'); }
        else console.log('  ? no candidate #' + ans + ' (1-' + cands.length + ') and no APL slug "' + ans + '".');
      }
      else if (slugSet.has(ans)) { newOverrides[key] = ans; decided = true; }
      else console.log('  ? "' + ans + '" is not a candidate or APL slug - use a number, a slug, null, <enter>, or q.');
    }
  }
  rl.close();
  return finish(overrides, newOverrides);
}

const finish = (overrides, added) => {
  const keys = Object.keys(added);
  if (!keys.length) { console.log('\nNo changes.'); return; }
  if (process.env.MANUAL_DRY) {
    console.log('\nDRY RUN - would write ' + keys.length + ' override(s) to ' + OVERRIDES_PATH + ':');
    for (const k of keys) console.log('  ' + k + ' -> ' + added[k]);
    return;
  }
  writeFileSync(OVERRIDES_PATH, JSON.stringify({ ...overrides, ...added }, null, 2) + '\n');
  console.log('\nWrote ' + keys.length + ' override(s) to ' + OVERRIDES_PATH + ':');
  for (const k of keys) console.log('  ' + k + ' -> ' + added[k]);
};

main().catch((e) => { console.error(e); process.exit(1); });
