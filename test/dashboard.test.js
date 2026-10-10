'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const D = require('../dashboard/core.js');
const root = path.resolve(__dirname, '..');
assert.equal(D.money('€ 30.428,45'), 30428.45);
for (const bad of ['', '1,2x', '-2', 'Infinity', '1.234,567', '<script>']) assert.equal(D.money(bad), null);
const ref = (motor = '243', tariff = '71') => ({ slug: 'ariya', variantId: '49', motorId: motor, tariffId: tariff });
const cache = { slugLines: { ariya: { fetchedAt: '2026-10-10T00:00:00Z', lines: [{ id: '49', name: 'Ariya Evolve', url: '/neuwagen/nissan/ariya/evolve/' }] } },
  motorSpecs: { 243: { kwh: 87, kw: 178 }, 242: { kwh: 87, kw: 225 } },
  lineData: { 49: { fetchedAt: '2026-10-10T00:00:00Z', data: { offers: {
    243: [{ tag: D.TAGS[0], motorId: '243', tariffId: '71', endpreis: '20.000,00', kaufpreis: '19.000,00', ersparnis: '1.000,00 (5,00)', lieferzeit: '2 Monate' }],
    242: [{ tag: D.TAGS[0], motorId: '242', tariffId: '71', endpreis: '30.000,00', kaufpreis: '29.000,00', ersparnis: '1.000,00 (5,00)', lieferzeit: '3 Monate' }]
  }, byMotor: {} } } } };
const entry = (motor) => { const offer = D.sourceOffer(ref(motor), D.TAGS[0], cache);return { slug: 'ariya', confidence: 1, ...offer, offers: [offer] }; };
const prices = { 'Nissan|Ariya 87kWh': entry('243'), 'Nissan|Ariya e-4ORCE 87kWh - 225 kW': entry('242'), 'Tesla|Model 3': { endpreis: '40.000,00', confidence: .8, offers: [] } };
assert.equal(D.sourceOffer(ref('242'), D.TAGS[0], cache).source.kw, 225);
assert.throws(() => D.sourceOffer(ref('242', '999'), D.TAGS[0], cache), /nicht gefunden/);
assert.throws(() => D.validate({ mapping: {}, prices: { 'Nissan|Ariya': { base: { source: ref(), values: { endpreis: '-10' } } } } }));
assert.throws(() => D.validate({ mapping: { 'Nissan|Ariya': { base: { ...ref(), slug: '../../evil' } } }, prices: {} }));
const config = { mapping: {}, prices: { 'Nissan|Ariya 87kWh': { base: { source: ref(), values: { endpreis: '21.111,00' } }, offers: { [D.TAGS[0]]: { source: ref(), values: { endpreis: '21.111,00' } } } } } };
D.validate(config);
const applied = D.applyPrices(prices, config);
assert.equal(applied.prices['Nissan|Ariya 87kWh'].endpreis, '21.111,00');
assert.deepEqual(D.rawPrices(applied), prices);
assert.equal(D.applyPrices(prices, { ...config, prices: { 'Nissan|Ariya 87kWh': { base: { source: ref('242'), values: { endpreis: '50.000,00' } } } } }).warnings.length, 1);
assert.deepEqual(D.affected(prices, ['49']).sort(), Object.keys(prices).filter((k) => k.startsWith('Nissan')).sort());
assert.equal(D.filterRows(prices, config, { query: 'ariya', min: 25000, max: 35000 }).length, 1);
assert.equal(D.filterRows(prices, config, { make: 'Tesla', uncertain: true }).length, 1);
assert.equal(D.filterRows(prices, config, { corrected: true }).length, 1);
assert.equal(D.filterRows(prices, config, { sort: 'price', direction: -1 })[0][0], 'Tesla|Model 3');
assert.equal(D.applyMappings(prices, { mapping: { 'Nissan|Ariya 87kWh': { base: ref('242') } }, prices: {} }, cache)['Nissan|Ariya 87kWh'].endpreis, '30.000,00');
assert.ok(!D.applyMappings(prices, { mapping: { 'Tesla|Model 3': null }, prices: {} }, cache)['Tesla|Model 3']);
const restrictedCache = D.clone(cache);
restrictedCache.lineData['49'].data.offers['243'].push({ tag: 'mit Kurzzulassung', motorId: '243', tariffId: '223', endpreis: '18.000,00', conditions: 'Haltefrist von 6 Monaten' });
const restrictedConfig = { mapping: { 'Nissan|Ariya 87kWh': { base: ref('243', '223'), offers: { 'mit Kurzzulassung': ref('243', '223') } } }, prices: {} };
D.validate(restrictedConfig);
const restricted = D.applyMappings(prices, restrictedConfig, restrictedCache)['Nissan|Ariya 87kWh'];
assert.equal(restricted.endpreis, '18.000,00');
assert.equal(restricted.conditions, 'Haltefrist von 6 Monaten');
assert.equal(restricted.tag, 'mit Kurzzulassung');
assert.equal(restricted.offers.find(o => o.tag === 'mit Kurzzulassung').source.tariffId, '223');
assert.throws(() => D.sourceOffer(ref('243', '223'), 'für Privatkunden', restrictedCache), /nicht gefunden/);
assert.equal(D.applyMappings({ 'Nissan|Ariya 87kWh': restricted }, { mapping: { 'Nissan|Ariya 87kWh': { base: ref() } }, prices: {} }, restrictedCache)['Nissan|Ariya 87kWh'].conditions, undefined);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apl-dashboard-test-'));
try {
  fs.mkdirSync(path.join(dir, 'tools'));fs.mkdirSync(path.join(dir, 'dashboard'));
  for (const file of ['scraper.js', 'matcher.js', 'dashboard/core.js', 'dashboard/evdb.js', 'tools/scrape-prices.mjs']) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  const initial = { generatedAt: '2026-10-10T00:00:00Z', count: 3, prices, lowConfidence: [], originalPrices: {}, appliedOverrides: D.empty(),
    modelUrls: { ariya: 'https://www.apl.de/neuwagen/nissan/ariya/modellvarianten/', 'model-3': 'https://www.apl.de/neuwagen/tesla/model-3/modellvarianten/' },
    vehicles: [{ make: 'Nissan', model: 'Ariya 87kWh' }, { make: 'Nissan', model: 'Ariya e-4ORCE 87kWh - 225 kW' }, { make: 'Tesla', model: 'Model 3' }] };
  const reset = (corrections = D.empty()) => {
    fs.writeFileSync(path.join(dir, 'apl-prices.json'), JSON.stringify(initial));
    fs.writeFileSync(path.join(dir, 'tools/scrape-cache.json'), JSON.stringify(cache));
    fs.writeFileSync(path.join(dir, 'tools/dashboard-overrides.json'), JSON.stringify(corrections));
  };
  fs.writeFileSync(path.join(dir, 'mock.mjs'), `
    import fs from 'node:fs';
    const calls=[];
    globalThis.fetch=async (url,opts={})=>{
      calls.push({url,body:opts.body});fs.writeFileSync('calls.json',JSON.stringify(calls));
      let body='';
      if(url.includes('getPreisliste.php')) {
        const motors=process.env.MISSING==='1'?['243']:['243','242'];
        body=motors.map(m=>'<div class=" preis-item" data-motor="'+m+'" data-tarif="71"><div class="data-endpreis">'+(m==='243'?'22.000,00':'33.000,00')+'</div><div class="data-kaufpreis">20.000,00</div><div class="data-ersparnis">1.000,00 (5,00)</div><div class="data-Lieferzeit">1 Monat</div><div class="data-AbholortText">Abholung beim Nissan-Vertragshändler</div></div>').join('');
        body+='<div class=" preis-item" data-motor="243" data-tarif="223"><div class="data-endpreis">18.000,00</div><div class="data-TarifInfos"><p>Das Fahrzeug wird vorab zugelassen, mit einer Haltefrist von 6 Monaten.</p></div><div class="data-AbholortText">Abholung beim Nissan-Vertragshändler</div></div>';
      }else if(url.endsWith('/modellvarianten/')) body='<h2>Ariya Evolve</h2><div class="FzgBlock-infos" data-id="49"></div><a href="/neuwagen/nissan/ariya/evolve/">Details</a>';
      else if(url.endsWith('/evolve/')) body='<div class="item-motor" data-id="243" data-sortkw="178" data-sortmotor="87kWh"><div class="item-motor" data-id="242" data-sortkw="225" data-sortmotor="87kWh">';
      else throw new Error('Unexpected full scrape: '+url);
      return {ok:true,text:async()=>body};
    };
    await import('./tools/scrape-prices.mjs');
  `);
  const run = (mode, target = '', extra = {}) => spawnSync(process.execPath, ['mock.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, APL_MODE: mode, APL_TARGET: target, ...extra } });
  reset(config);
  let result = run('offer', JSON.stringify({ ...ref(), tag: D.TAGS[0] }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  let output = JSON.parse(fs.readFileSync(path.join(dir, 'apl-prices.json')));
  assert.equal(output.prices['Nissan|Ariya 87kWh'].endpreis, '21.111,00', 'manual price survives refresh');
  assert.equal(output.originalPrices['Nissan|Ariya 87kWh'].endpreis, '22.000,00');
  assert.equal(output.prices['Nissan|Ariya e-4ORCE 87kWh - 225 kW'].endpreis, '33.000,00', 'shared source updates other vehicle');
  assert.deepEqual(output.prices['Tesla|Model 3'], prices['Tesla|Model 3']);
  const calls = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json')));
  assert.equal(calls.filter((c) => c.url.includes('getPreisliste.php')).length, 1, 'bypass fresh cache, fetch one variant only');
  reset();const before=fs.readFileSync(path.join(dir, 'apl-prices.json'), 'utf8');
  result=run('offer', JSON.stringify(ref()), { MISSING: '1' });
  assert.notEqual(result.status, 0, 'disappeared shared offer fails');
  assert.equal(fs.readFileSync(path.join(dir, 'apl-prices.json'), 'utf8'), before, 'failure must not change data');
  reset(restrictedConfig);
  fs.writeFileSync(path.join(dir,'tools/scrape-cache.json'),JSON.stringify(restrictedCache));
  result=run('corrections');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  output=JSON.parse(fs.readFileSync(path.join(dir, 'apl-prices.json')));
  assert.equal(output.prices['Nissan|Ariya 87kWh'].tag, 'mit Kurzzulassung');
  assert.match(output.prices['Nissan|Ariya 87kWh'].conditions, /Haltefrist von 6 Monaten/);
  result=run('offer',JSON.stringify({...ref('243','223'),tag:'mit Kurzzulassung'}));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  output=JSON.parse(fs.readFileSync(path.join(dir, 'apl-prices.json')));
  assert.equal(output.prices['Nissan|Ariya 87kWh'].endpreis, '18.000,00', 'restricted base survives targeted refresh');
  assert.equal(output.prices['Nissan|Ariya e-4ORCE 87kWh - 225 kW'].endpreis, '33.000,00');
  assert.deepEqual(output.prices['Tesla|Model 3'],prices['Tesla|Model 3']);
  reset(config);fs.rmSync(path.join(dir,'calls.json'),{force:true});result=run('corrections');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!fs.existsSync(path.join(dir,'calls.json')), 'numeric correction needs no scraping');
  reset({mapping:{'Nissan|Ariya 87kWh':{evdbOnly:true}},prices:{}});fs.rmSync(path.join(dir,'calls.json'),{force:true});
  result=run('corrections');assert.equal(result.status,0,result.stdout+result.stderr);
  assert(!fs.existsSync(path.join(dir,'calls.json')),'EVDB-only needs no APL request');
  output=JSON.parse(fs.readFileSync(path.join(dir,'apl-prices.json')));assert(!output.prices['Nissan|Ariya 87kWh']);assert.deepEqual(output.prices['Tesla|Model 3'],prices['Tesla|Model 3']);
  const pinned = D.clone(config);pinned.mapping['Nissan|Ariya 87kWh'] = { base: ref() };
  reset(pinned);
  const pinnedInitial = { ...initial, appliedOverrides: pinned };
  fs.writeFileSync(path.join(dir, 'apl-prices.json'), JSON.stringify(pinnedInitial));
  const expired = D.clone(cache);expired.slugLines.ariya.fetchedAt = '2020-01-01';expired.lineData[49].fetchedAt = '2020-01-01';
  fs.writeFileSync(path.join(dir, 'tools/scrape-cache.json'), JSON.stringify(expired));
  result = run('corrections');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!fs.existsSync(path.join(dir,'calls.json')), 'unchanged pinned source and numeric correction need no scraping');
  reset();result=run('vehicle','Nissan|Ariya 87kWh');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  output=JSON.parse(fs.readFileSync(path.join(dir, 'apl-prices.json')));
  assert.equal(output.prices['Nissan|Ariya e-4ORCE 87kWh - 225 kW'].source.motorId,'242');
  assert.equal(output.prices['Nissan|Ariya 87kWh'].source.motorId,'243');
  assert.deepEqual(output.prices['Tesla|Model 3'], prices['Tesla|Model 3']);
  // Repeat targeted refresh with canonical IDs, including a duplicate historic name.
  reset();
  const evdbVehicles=initial.vehicles.map((v,i)=>({...v,id:String(i+1),status:'current'}));
  evdbVehicles.push({...evdbVehicles[0],id:'9',status:'archive'});
  fs.writeFileSync(path.join(dir,'evdb-vehicles.json'),JSON.stringify({vehicles:evdbVehicles}));
  const ids=Object.fromEntries(initial.vehicles.map((v,i)=>['evdb:'+String(i+1),prices[v.make+'|'+v.model]]));
  fs.writeFileSync(path.join(dir,'apl-prices.json'),JSON.stringify({...initial,pricesByEvdbId:ids,originalPricesByEvdbId:{}}));
  result=run('vehicle','evdb:1');assert.equal(result.status,0,result.stdout+result.stderr);
  output=JSON.parse(fs.readFileSync(path.join(dir,'apl-prices.json')));
  assert.equal(output.pricesByEvdbId['evdb:1'].source.motorId,'243');
  assert.equal(output.pricesByEvdbId['evdb:2'].source.motorId,'242');
  assert.deepEqual(output.pricesByEvdbId['evdb:3'],ids['evdb:3']);
  assert(!output.pricesByEvdbId['evdb:9'],'archive gets no automatic APL assignment');
  assert(!output.prices['Nissan|Ariya 87kWh'],'ambiguous legacy name is omitted');
  const unchanged=fs.readFileSync(path.join(dir,'apl-prices.json'),'utf8');
  result=run('offer',JSON.stringify(ref()),{MISSING:'1'});assert.notEqual(result.status,0);
  assert.equal(fs.readFileSync(path.join(dir,'apl-prices.json'),'utf8'),unchanged);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('PASS: dashboard filters, bound corrections, exact motor/tariff mapping, shared targeted refresh and failure safety');

// Exercise publication against a local Git remote: disjoint results merge,
// overlapping price updates and changed assignments cannot be overwritten.
{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apl-publication-test-'));
  const { execFileSync }=require('node:child_process');
  const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
  const write=(cwd,file,value)=>fs.writeFileSync(path.join(cwd,file),JSON.stringify(value,null,2)+'\n');
  try {
    const remote=path.join(dir,'remote.git'), work=path.join(dir,'work'), other=path.join(dir,'other');
    fs.mkdirSync(work);git(dir,'init','--bare','--initial-branch=main',remote);
    git(work,'init','--initial-branch=main');git(work,'config','user.name','Test');git(work,'config','user.email','test@example.com');
    fs.mkdirSync(path.join(work,'tools'));fs.mkdirSync(path.join(work,'dashboard'));
    fs.copyFileSync(path.join(root,'tools/publish-prices.mjs'),path.join(work,'tools/publish-prices.mjs'));
    fs.copyFileSync(path.join(root,'dashboard/core.js'),path.join(work,'dashboard/core.js'));
    fs.copyFileSync(path.join(root,'dashboard/evdb.js'),path.join(work,'dashboard/evdb.js'));
    fs.copyFileSync(path.join(root,'tools/publish-evdb.mjs'),path.join(work,'tools/publish-evdb.mjs'));
    const vehicles=[{id:'1',make:'A',model:'One',status:'current'},{id:'2',make:'B',model:'Two',status:'current'}];
    write(work,'evdb-vehicles.json',{fetchedAt:'2026-10-10T00:00:00Z',vehicles});
    const base={padding:'x'.repeat(1200000),count:2,prices:{'A|One':{endpreis:'10.000,00'},'B|Two':{endpreis:'20.000,00'}},originalPrices:{},appliedOverrides:D.empty(),lowConfidence:[]};
    write(work,'apl-prices.json',base);write(work,'tools/scrape-cache.json',{slugLines:{},lineData:{},motorSpecs:{}});write(work,'tools/dashboard-overrides.json',D.empty());
    git(work,'add','.');git(work,'commit','-m','baseline');git(work,'remote','add','origin',remote);git(work,'push','origin','main');
    git(dir,'clone',remote,other);git(other,'config','user.name','Other');git(other,'config','user.email','other@example.com');
    write(other,'evdb-vehicles.json',{padding:'x'.repeat(1200000),fetchedAt:'2026-10-10T02:00:00Z',vehicles:[...vehicles,{id:'9',make:'A',model:'One',status:'archive'}]});
    const newer=D.clone(base);newer.prices['B|Two'].endpreis='25.000,00';write(other,'apl-prices.json',newer);git(other,'add','.');git(other,'commit','-m','other source');git(other,'push');
    const updated=D.clone(base);updated.prices['A|One'].endpreis='11.000,00';
    updated.pricesByEvdbId={'evdb:1':updated.prices['A|One'],'evdb:2':updated.prices['B|Two']};updated.originalPricesByEvdbId={};updated.vehicles=vehicles;write(work,'apl-prices.json',updated);
    const hash=require('node:crypto').createHash('sha256').update(JSON.stringify(base.prices['A|One'])).digest('hex');
    write(work,'tools/scrape-result.json',{mode:'offer',correctionText:fs.readFileSync(path.join(work,'tools/dashboard-overrides.json'),'utf8'),changedKeys:['evdb:1'],baseline:{'evdb:1':hash},touched:[],cacheBaseline:{}});
    let result=spawnSync(process.execPath,['tools/publish-prices.mjs'],{cwd:work,encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const merged=JSON.parse(git(work,'show','origin/main:apl-prices.json'));
    assert.equal(JSON.parse(git(work,'show','origin/main:evdb-vehicles.json')).fetchedAt,'2026-10-10T02:00:00Z','APL publication preserves newer EVDB');
    assert.equal(merged.pricesByEvdbId['evdb:1'].endpreis,'11.000,00');assert(!merged.prices['A|One'],'latest EVDB generations govern legacy compatibility');assert.equal(merged.prices['B|Two'].endpreis,'25.000,00');
    write(work,'apl-prices.json',updated);
    write(work,'tools/scrape-result.json',{mode:'offer',correctionText:fs.readFileSync(path.join(work,'tools/dashboard-overrides.json'),'utf8'),changedKeys:['evdb:1'],baseline:{'evdb:1':hash},touched:[],cacheBaseline:{}});
    updated.pricesByEvdbId['evdb:1'].endpreis='12.000,00';write(work,'apl-prices.json',updated);
    result=spawnSync(process.execPath,['tools/publish-prices.mjs'],{cwd:work,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/Concurrent update/);
    git(other,'pull','--ff-only');
    write(other,'tools/dashboard-overrides.json',{mapping:{'A|One':null},prices:{}});
    git(other,'add','tools/dashboard-overrides.json');git(other,'commit','-m','changed assignment');git(other,'push');
    result=spawnSync(process.execPath,['tools/publish-prices.mjs'],{cwd:work,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/Corrections changed during scrape/);
    write(work,'evdb-vehicles.json',{fetchedAt:'2026-10-10T03:00:00Z',vehicles:[{id:'2'}]});
    result=spawnSync(process.execPath,['tools/publish-evdb.mjs'],{cwd:work,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(git(work,'show','origin/main:apl-prices.json')),merged,'EVDB publication preserves APL');
    write(work,'evdb-vehicles.json',{fetchedAt:'2026-10-10T01:00:00Z',vehicles:[]});
    result=spawnSync(process.execPath,['tools/publish-evdb.mjs'],{cwd:work,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(git(work,'show','origin/main:evdb-vehicles.json')).fetchedAt,'2026-10-10T03:00:00Z','old EVDB run cannot roll back data');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  console.log('PASS: publication merges disjoint updates and rejects overlapping updates');
}
