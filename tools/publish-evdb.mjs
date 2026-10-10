// CI checkout only: publish this file independently, preserving parallel APL commits.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const dataset = JSON.parse(readFileSync('evdb-vehicles.json', 'utf8'));
for (let attempt = 0; attempt < 3; attempt++) {
  git('fetch', 'origin', 'main');
  let latest;
  try { latest = JSON.parse(git('show', 'origin/main:evdb-vehicles.json')); } catch (e) { if (!String(e.stderr).includes('does not exist')) throw e; }
  if (latest?.fetchedAt >= dataset.fetchedAt) break;
  git('reset', '--hard', 'origin/main');
  writeFileSync('evdb-vehicles.json', JSON.stringify(dataset, null, 2) + '\n');
  git('add', 'evdb-vehicles.json');git('commit', '-m', 'evdb: update overview database');
  try { git('push', 'origin', 'HEAD:main');break; } catch (e) { if (attempt === 2) throw e; }
}
