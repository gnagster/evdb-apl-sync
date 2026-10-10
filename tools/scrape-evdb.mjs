import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import E from '../dashboard/evdb.js';
let previous;
try { previous = JSON.parse(readFileSync('evdb-vehicles.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const response = await fetch('https://ev-database.org/', { headers: { 'User-Agent': 'evdb-apl-sync/1.0', Accept: 'text/html' }, signal: AbortSignal.timeout(60000) });
if (!response.ok) throw Error('EVDB HTTP ' + response.status + '; letzter Bestand bleibt erhalten.');
const dataset = E.parse(await response.text(), previous);
writeFileSync('evdb-vehicles.json.tmp', JSON.stringify(dataset, null, 2) + '\n');
renameSync('evdb-vehicles.json.tmp', 'evdb-vehicles.json');
console.log('EVDB: ' + dataset.vehicles.length + ' Fahrzeuge; ' + dataset.filters.ranges.length + ' Bereichsfilter.');
