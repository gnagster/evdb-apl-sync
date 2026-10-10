'use strict';
const assert = require('node:assert/strict');
const E = require('../dashboard/evdb.js'), D = require('../dashboard/core.js');
const { priceForVehicle } = require('../content.js');
const database = require('../evdb-vehicles.json');
assert.equal(database.filters.ranges.length,12);assert.equal(Object.keys(database.filters.groups).length,9);assert.equal(E.sorts.length,19);
assert(database.vehicles.length >= 1000);assert.equal(new Set(database.vehicles.map(v=>v.id)).size,database.vehicles.length);
assert.equal(E.number('€65,900'),65900);assert.equal(E.number('No Data'),null);assert.equal(E.number('-'),null);
assert(database.vehicles.filter(v=>v.status!=='archive').every(v=>v.availableTo===null));
const cfg = D.empty(), rows = (f={}, prices={}) => E.rows(database,prices,cfg,f,D.money);
for(const [group,def] of Object.entries(database.filters.groups)) {
  for(const {value} of def.options) {
    const found=rows({groups:{[group]:[value]}});
    assert(found.every(([,v])=>group==='availability'?v.status===value:v.tokens.includes(value)),group+': '+value);
  }
}
const all = rows(), current = rows({groups:{availability:['current']}});
assert(current.length>0 && current.length<all.length);
assert.equal(rows({groups:{availability:['current','archive','upcoming']}}).length,all.length);
assert(rows({groups:{features:['pnc','heatpump'],drive:['awd']}}).every(([,v])=>['pnc','heatpump','awd'].every(t=>v.tokens.includes(t))));
for(const def of database.filters.ranges) {
  assert.equal(rows({ranges:{[def.field]:{min:def.min,max:def.max}}}).length,all.length,'full range '+def.field);
  const f={min:def.min+def.step,max:def.max-def.step};
  assert(rows({ranges:{[def.field]:f}}).every(([,v])=>def.field==='years' ? v.yearFrom<=f.max && (v.yearTo??Infinity)>=f.min : v[def.field]!=null && v[def.field]>=f.min && v[def.field]<=f.max),def.field);
}
const v=database.vehicles.find(v=>v.status==='current' && v.rangeKm>0 && v.priceEur>0), k=E.key(v);
const ref={slug:'test',variantId:'1',motorId:'2',tariffId:'3'}, prices={[k]:{endpreis:'20.000,00',source:ref,offers:[{tag:D.TAGS[1],endpreis:'18.000,00',source:ref}],confidence:.7}};
const config={mapping:{},prices:{[k]:{base:{source:ref,values:{endpreis:'30.000,00'}}}}};D.validate(config);
let applied=D.applyPrices(prices,config);let found=E.rows(database,applied.prices,config,{},D.money).find(([id])=>id===k)[1];
assert.equal(found.priceEur,30000);assert.equal(found.pricePerKm,30000/v.rangeKm);assert.equal(found.priceSource,'APL · korrigiert');
assert.equal(E.rows(database,prices,cfg,{tag:D.TAGS[1]},D.money).length,1);
assert.equal(E.rows(database,prices,cfg,{tag:D.TAGS[1]},D.money)[0][1].priceEur,18000);
assert.equal(E.rows(database,prices,{mapping:{[k]:null},prices:{}},{},D.money).some(([id])=>id===k),false);
const historical={...database,vehicles:[{...v,status:'archive'}]};
assert.equal(E.rows(historical,prices,cfg,{},D.money)[0][1].priceEur,v.priceEur);
assert.equal(E.rows(historical,prices,{mapping:{[k]:{base:ref}},prices:{}},{},D.money)[0][1].priceEur,20000);
assert.equal(rows().find(([id])=>id===k)[1].priceEur,v.priceEur);
assert.equal(D.applyPrices(D.rawPrices({pricesByEvdbId:applied.prices,originalPricesByEvdbId:applied.originalPrices}),cfg).prices[k].endpreis,'20.000,00');
const small={...database,vehicles:[{...v,id:'1',rangeKm:100,priceEur:5000,yearFrom:2011,yearTo:2014},{...v,id:'2',rangeKm:null,priceEur:200000,yearFrom:2020,yearTo:null},{...v,id:'3',rangeKm:100,priceEur:null,yearFrom:null,yearTo:null}]};
const r=(f={})=>E.rows(small,{},cfg,f,D.money);
assert.equal(r({ranges:{priceEur:{min:15000,max:100000}}})[0][1].id,'2','open upper price');
assert.equal(r({ranges:{rangeKm:{min:50,max:150}}}).length,2);
assert.equal(r({ranges:{rangeKm:{min:50,max:150,unknown:true}}}).length,3);
assert.equal(r({ranges:{rangeKm:{unknownOnly:true}}})[0][1].id,'2');
assert.deepEqual(r({ranges:{years:{min:2013,max:2013}}}).map(([,v])=>v.id),['1']);
assert.deepEqual(r({ranges:{years:{min:2027,max:2030}}}).map(([,v])=>v.id),['2']);
for(const [sort,,field,direction] of E.sorts) {
  const out=r({sort});for(let i=1;i<out.length;i++) {
    const a=out[i-1][1][field],b=out[i][1][field];if(a==null) assert(b==null,sort+' null last');
    else if(b!=null) assert((typeof a==='string'?a.localeCompare(b,'de'):a-b)*direction<=0,sort);
  }
}
const duplicate=[{...v,id:'1'},{...v,id:'2'}];
const name=v.make+'|'+v.model,m=E.migrate({mapping:{[name]:null},prices:{}},duplicate);
assert.deepEqual(m.conflicts,[name]);assert(name in m.config.mapping);assert.deepEqual(E.legacy({'evdb:1':prices[k]},duplicate),{});
assert.equal(priceForVehicle({pricesByEvdbId:{'evdb:1':prices[k]},prices:{[name]:prices[k]}},'2',name),undefined);
assert.equal(priceForVehicle({prices:{[name]:prices[k]}},'2',name),prices[k]);
assert.equal(E.migrate({mapping:{[name]:null},prices:{}},[v]).config.mapping[k],null);
assert.throws(()=>D.validate({mapping:{'evdb:not-an-id':null},prices:{}}));
assert.throws(()=>E.parse('<html>failure</html>',database));
const fs=require('node:fs');const fixture=fs.readFileSync(require.resolve('./fixtures/evdb-overview.html'),'utf8');
const split=fixture.split('<div class="list-item" data-jplist-item>');
const html=split[0]+Array.from({length:1000},(_,i)=>'<div class="list-item" data-jplist-item>'+split[1].replace(/3657/g,String(5000+i))).join('');
const parsed=E.parse(html+'</html>');assert.equal(parsed.vehicles[0].model,'i3 50 xDrive (MY27)');assert.equal(parsed.vehicles[0].priceEur,65900);assert.equal(parsed.vehicles[0].availableTo,null);
assert.throws(()=>E.parse((html+'</html>').replace(/class="battery hidden"/g,'class="missing hidden"')));
assert.throws(()=>E.parse((html+'</html>').replace('data-path=".rank"','data-path=".unknown"')));
assert.throws(()=>E.parse((html+'</html>').replace(/data-vehicle-id="\d+"/g,'data-vehicle-id="1"')));
console.log('PASS: complete EVDB inventory, all filters/ranges/sorts, unknowns, open bounds, year overlap, effective prices, ID migration and extension compatibility');
