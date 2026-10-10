// Merge disjoint scrape results; overlapping updates must be retried, never overwritten.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import D from '../dashboard/core.js';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const result = JSON.parse(readFileSync('tools/scrape-result.json', 'utf8'));
const output = JSON.parse(readFileSync('apl-prices.json', 'utf8'));
const cache = JSON.parse(readFileSync('tools/scrape-cache.json', 'utf8'));
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const readRemote = (path) => git('show', 'origin/main:' + path);
for (let attempt = 0; attempt < 3; attempt++) {
  git('fetch', 'origin', 'main');
  if (readRemote('tools/dashboard-overrides.json') + '\n' !== result.correctionText &&
      readRemote('tools/dashboard-overrides.json') !== result.correctionText) {
    throw new Error('Corrections changed during scrape. Please retry against the latest assignments.');
  }
  const latest = JSON.parse(readRemote('apl-prices.json'));
  const latestCache = JSON.parse(readRemote('tools/scrape-cache.json'));
  const latestRaw = D.rawPrices(latest), outputRaw = D.rawPrices(output);
  for (const key of result.changedKeys) {
    if (digest(latestRaw[key] || null) !== result.baseline[key] &&
        digest(latestRaw[key] || null) !== digest(outputRaw[key] || null)) {
      throw new Error('Concurrent update for ' + key + '. Please retry.');
    }
  }
  for (const id of result.touched) {
    if (digest(latestCache.lineData[id] || null) !== result.cacheBaseline[id] &&
        digest(latestCache.lineData[id] || null) !== digest(cache.lineData[id] || null)) {
      throw new Error('Concurrent APL source update: ' + id + '. Please retry.');
    }
  }
  for (const key of result.changedKeys) {
    if (outputRaw[key]) latestRaw[key] = outputRaw[key]; else delete latestRaw[key];
  }
  const applied = D.applyPrices(latestRaw, output.appliedOverrides);
  const merged = { ...latest, ...output, ...applied, count: Object.keys(applied.prices).length };
  if (result.mode !== 'full') {
    merged.lowConfidence = Object.entries(merged.prices).filter(([, v]) => v.confidence < 0.85).map(([k]) => k);
  }
  const combinedCache = { slugLines: { ...latestCache.slugLines, ...cache.slugLines },
    motorSpecs: { ...latestCache.motorSpecs, ...cache.motorSpecs }, lineData: { ...latestCache.lineData } };
  // Preserve newer unrelated structures/specs when another scrape completed first.
  for (const [slug, value] of Object.entries(latestCache.slugLines)) {
    if (value.fetchedAt > (combinedCache.slugLines[slug]?.fetchedAt || '')) combinedCache.slugLines[slug] = value;
  }
  for (const id of result.touched) combinedCache.lineData[id] = cache.lineData[id];
  git('reset', '--hard', 'origin/main');
  writeFileSync('apl-prices.json', JSON.stringify(merged, null, 2) + '\n');
  writeFileSync('tools/scrape-cache.json', JSON.stringify(combinedCache, null, 2) + '\n');
  git('add', 'apl-prices.json', 'tools/scrape-cache.json');
  if (!git('diff', '--cached', '--name-only')) break;
  git('commit', '-m', 'apl-prices: ' + result.mode + ' update');
  try { git('push', 'origin', 'HEAD:main'); break; }
  catch (error) { if (attempt === 2) throw error; }
}
