import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import D from '../dashboard/core.js';
import {verifyProposal,parseSpecs,safeUrl,agent,applyCorrection,authenticate,GH} from '../worker/agent.mjs';
import worker from '../worker/index.mjs';
globalThis.crypto ||= webcrypto;
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const ref={slug:'ariya',variantId:'49',motorId:'243',tariffId:'71'};
const offer={tag:'für Privatkunden',motorId:'243',tariffId:'71',endpreis:'30.000,00',kaufpreis:'29.000,00',lieferzeit:'2 Monate'};
function fixture(){return {fileSha:'config-sha',sha:'main-sha',database:{fetchedAt:'today',vehicles:[{id:'1',make:'Nissan',model:'Ariya 87kWh',title:'Nissan Ariya 87kWh',status:'current',tokens:[],rangeKm:450,stopRangeKm:460,efficiencyWhKm:200,batteryKwh:87,priceEur:50000,url:'https://ev-database.org/car/1/Nissan-Ariya'}],filters:{groups:{},ranges:[]}},prices:{pricesByEvdbId:{'evdb:1':{endpreis:'40.000,00',source:ref,offers:[]}},modelUrls:{ariya:'https://www.apl.de/neuwagen/nissan/ariya/modellvarianten/'}},config:D.empty(),cache:{slugLines:{ariya:{lines:[{id:'49',name:'Ariya Evolve',url:'/neuwagen/nissan/ariya/evolve/'}]}},lineData:{49:{fetchedAt:new Date().toISOString(),data:{offers:{243:[offer]}}}},motorSpecs:{243:{kw:178,kwh:87,electric:true,fuel:'Strom'}}}};}
const specs={powerKw:178,nominalKwh:91,usableKwh:87,drive:'Front'};
const proposal={base:ref,offers:{'für Privatkunden':ref},reason:'Gleiche Modellfamilie, rein elektrischer Antrieb, 87 kWh nutzbar und 178 kW bestätigt.'};
test('exact electric source, battery, power, freshness and tags required',async()=>{
  let s=fixture();const p=await verifyProposal(s,'1',proposal,specs);assert.equal(p.after.endpreis,'30.000,00');
  for(const change of [s=>s.cache.motorSpecs[243].electric=false,s=>s.cache.motorSpecs[243].kw=225,s=>s.cache.motorSpecs[243].kwh=63,s=>s.cache.lineData[49].fetchedAt='2020-01-01',s=>s.database.vehicles[0].status='archive']){
    s=fixture();change(s);await assert.rejects(verifyProposal(s,'1',proposal,specs));
  }
  s=fixture();s.cache.motorSpecs[244]={...s.cache.motorSpecs[243]};s.cache.lineData[49].data.offers[244]=[{...offer,motorId:'244'}];await assert.rejects(verifyProposal(s,'1',proposal,specs),/Mehrere Motorisierungen/);
  await assert.rejects(verifyProposal(fixture(),'1',{...proposal,offers:{'für Geschäftskunden':ref}},specs),/nicht gefunden/);
  s=fixture();s.database.vehicles[0].model='Ariya Evolve';s.cache.slugLines.ariya.lines.push({id:'50',name:'Ariya Engage',url:'/neuwagen/nissan/ariya/engage/'});s.cache.lineData[50]=s.cache.lineData[49];
  await assert.rejects(verifyProposal(s,'1',{...proposal,base:{...ref,variantId:'50'}},specs),/Ausstattungsvariante/);
});
test('spec parsing and untrusted URLs',()=>{
  assert.deepEqual(parseSpecs('<td>Nominal Capacity *</td><td>91.0 kWh</td><td>Useable Capacity</td><td>87.0 kWh</td><td>Total Power</td><td>178 kW</td><td>Total Torque</td><td>300 Nm</td><td>Drive</td><td>Front</td>'),specs);
  for(const url of ['http://example.com','https://localhost/x','https://127.0.0.1/','https://a.internal','https://u:p@example.com/','https://example.com:444/'])assert.throws(()=>safeUrl(url));
  assert.equal(safeUrl('https://example.com/article'),'https://example.com/article');
});
test('chat tools use actual data and never send the GitHub credential to DeepSeek',async()=>{
  const events=[],s=fixture(),calls=[];let round=0;
  globalThis.fetch=async(url,options)=>{calls.push({url,options});const body=JSON.parse(options.body);assert.equal(body.model,'deepseek-flash');assert(!options.body.includes('github-private-credential'));return Response.json({choices:[{message:++round===1?{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'find_vehicles',arguments:'{"query":"Ariya"}'}}]}:{role:'assistant',content:'Nissan Ariya passt. Welche jährliche Fahrleistung hast du?'}}],usage:{prompt_tokens:100,completion_tokens:20}});};
  await agent({DEEPSEEK_API_KEY:'deepseek-test'},s,{messages:[{role:'user',content:'Welches Auto passt?'}]},(type,value)=>events.push({type,...value}),new AbortController().signal);
  assert.equal(calls.length,2);const tool=JSON.parse(calls[1].options.body).messages.find(m=>m.role==='tool');assert.equal(JSON.parse(tool.content).vehicles[0].priceEur,40000);assert(events.some(e=>e.type==='answer'));
});
test('correction stops for a targeted refresh instead of silently using stale prices',async()=>{
  const s=fixture(),events=[];s.cache.lineData[49].fetchedAt='2020-01-01';
  globalThis.fetch=async()=>Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',function:{name:'apl_offers',arguments:'{"slug":"ariya"}'}}]}}]});
  await agent({DEEPSEEK_API_KEY:'test'},s,{mode:'correction',vehicleId:'1'},(type,value)=>events.push({type,...value}),new AbortController().signal);
  assert(events.some(e=>e.type==='refresh'&&e.slug==='ariya'));assert(!events.some(e=>e.type==='proposal'));
});
test('fixed table filters constrain model searches and TCO returns explicit normalized percentages',async()=>{
  const s=fixture(),events=[];let round=0,searchResult;
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    if(round++) {searchResult=JSON.parse(body.messages.find(m=>m.tool_call_id==='find').content);return Response.json({choices:[{message:{role:'assistant',content:'Fertig.'}}]});}
    const schema=body.tools.find(t=>t.function.name==='calculate_tco').function.parameters.properties.inputs.properties;
    assert.equal(schema.homeSharePercent.maximum,100);assert.match(schema.homeSharePercent.description,/kein Bruch/);assert(!schema.homeShare);
    return Response.json({choices:[{message:{role:'assistant',tool_calls:[
      {id:'find',type:'function',function:{name:'find_vehicles',arguments:'{}'}},
      {id:'cost',type:'function',function:{name:'calculate_tco',arguments:JSON.stringify({id:'1',inputs:{years:5,annualKm:10000,resale:15000,homePrice:.3,homeSharePercent:100,lossPercent:0,insurance:500,tax:0,maintenance:200,tyres:100,thg:100}})}}
    ]}}]});
  };
  await agent({DEEPSEEK_API_KEY:'test'},s,{messages:[{role:'user',content:'Kosten?'}],filters:{query:'Kein Treffer'}},(type,value)=>events.push({type,...value}),new AbortController().signal);
  assert.equal(searchResult.count,0);
  const tco=events.find(e=>e.type==='tco');assert.equal(tco.inputs.homeSharePercent,100);assert.equal(tco.inputs.loanMonths,60);assert.equal(tco.inputs.financed,false);assert.equal(tco.result.total,31500);
});
test('applying verified correction preserves other vehicles and rejects conflicts',async()=>{
  const s=fixture();s.config.mapping['evdb:2']={evdbOnly:true};s.config.prices['evdb:1']={base:{source:ref,values:{endpreis:'9.000,00'}}};let written;
  globalThis.fetch=async(url,options)=>{
    if(url.startsWith('https://ev-database.org/'))return new Response('Total Power 178 kW Total Torque 300 Nm Drive Front Nominal Capacity 91 kWh Useable Capacity 87 kWh');
    assert.equal(url,GH+'/contents/tools/dashboard-overrides.json');written=JSON.parse(options.body);return Response.json({commit:{sha:'new-commit',html_url:'https://github.com/test/commit'}});
  };
  const checked={...(await verifyProposal(s,'1',proposal,specs))};const result=await applyCorrection('github-private-credential',s,checked,new AbortController().signal);
  const config=JSON.parse(Buffer.from(written.content,'base64').toString());assert.deepEqual(config.mapping['evdb:2'],{evdbOnly:true});assert(!config.prices['evdb:1']);assert.equal(written.sha,'config-sha');assert.equal(result.commit,'new-commit');
  await assert.rejects(applyCorrection('token',s,{...checked,configSha:'other'},new AbortController().signal),/zwischenzeitlich/);
});
test('authentication and API boundary refuse unauthenticated and cross-origin requests',async()=>{
  const make=(headers={})=>new Request('https://ev.dinne.beer/api/chat',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{"messages":[{"role":"user","content":"Hallo"}]}'});
  assert.equal((await worker.fetch(make(),{})).status,401);
  assert.equal((await worker.fetch(make({Origin:'https://evil.example'}),{})).status,403);
  globalThis.fetch=async()=>Response.json({permissions:{push:false}});await assert.rejects(authenticate(make({Authorization:'Bearer test'}),{}),/Schreibzugriff/);
  globalThis.fetch=async()=>Response.json({permissions:{push:true}});await assert.rejects(authenticate(make({Authorization:'Bearer test'}),{AI_LIMITER:{limit:async()=>({success:false})}}),/Zu viele/);
  assert.equal((await worker.fetch(new Request('https://ev.dinne.beer/api/unknown'),{})).status,404);
});
