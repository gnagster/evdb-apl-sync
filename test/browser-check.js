async (page) => {
 await page.evaluate(()=>localStorage.clear());await page.reload();
 const ensure=(ok,msg)=>{if(!ok)throw Error(msg)};
 const ref={slug:'ariya',variantId:'49',motorId:'243',tariffId:'71'};
 let config={mapping:{},prices:{}},writes=0;
 const vehicles=[1,2].map(id=>({id:String(id),make:'Test',model:'Auto '+id,title:'Test Auto '+id,status:'current',tokens:[],priceEur:id===1?30000:40000,rangeKm:400,stopRangeKm:450,efficiencyWhKm:200,batteryKwh:80,url:'https://ev-database.org/car/'+id+'/Test'}));
 const cache={slugLines:{ariya:{lines:[{id:'49',name:'Ariya Evolve',url:'/neuwagen/nissan/ariya/evolve/'}]}},lineData:{49:{fetchedAt:new Date().toISOString(),data:{offers:{243:[{tag:'für Privatkunden',motorId:'243',tariffId:'71',endpreis:'30.000,00'}]}}}},motorSpecs:{243:{electric:true,kw:178,kwh:87}}};
 const prices=()=>({count:2,prices:{},pricesByEvdbId:{'evdb:1':{endpreis:'30.000,00',source:ref,offers:[]}},appliedOverrides:config,modelUrls:{ariya:'https://www.apl.de/neuwagen/nissan/ariya/modellvarianten/'},generatedAt:new Date().toISOString()});
 const json=(route,body)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 await page.route('https://api.github.com/**',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.endsWith('/evdb-apl-sync'))return json(route,{permissions:{push:true}});
  if(u.pathname.endsWith('/commits/main'))return json(route,{sha:'fixture'});
  if(u.pathname.includes('/contents/'))return json(route,{sha:'fixture-config',content:Buffer.from(JSON.stringify(config)).toString('base64')});
  if(u.pathname.endsWith('/runs'))return json(route,{workflow_runs:[{id:1,event:'push',head_sha:'saved-fixture',status:'completed',conclusion:'success',html_url:'https://github.com/test/run'}]});
  throw Error('Unexpected GitHub request '+u.pathname);
 });
 await page.route('https://raw.githubusercontent.com/**',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.endsWith('evdb-vehicles.json'))return json(route,{vehicles,filters:{groups:{availability:{label:'Verfügbarkeit',options:[{value:'current',label:'Bestellbar'}]}},ranges:[]}});
  if(u.pathname.endsWith('scrape-cache.json'))return json(route,cache);
  if(u.pathname.endsWith('apl-prices.json'))return json(route,prices());
  throw Error('Unexpected raw request');
 });
 await page.route('**/api/chat',async route=>{
  const req=route.request().postDataJSON();ensure(req.messages.length>0,'Chat history missing');
  await route.fulfill({status:200,contentType:'application/x-ndjson',body:JSON.stringify({type:'status',text:'Quellen werden geprüft …'})+'\n'+JSON.stringify({type:'answer',text:'**Testberatung** mit [Quelle](https://example.com). <script>window.BAD=true</script> Welche Fahrleistung hast du?',sources:[]})+'\n'});
 });
 await page.route('**/api/vehicle-check',route=>route.fulfill({status:200,contentType:'application/x-ndjson',body:JSON.stringify({type:'proposal',vehicleId:'1',mapping:{base:ref,offers:{}},configSha:'fixture-config',checkedAt:new Date().toISOString(),reason:'Technische Variante anhand der Quellen bestätigt.'})+'\n'}));
 await page.route('**/api/vehicle-correction',async route=>{writes++;config.mapping['evdb:1']={base:ref,offers:{}};return json(route,{commit:'saved-fixture',url:'https://github.com/test/commit',before:{priceEur:31000},after:{endpreis:'30.000,00'},reason:'Technische Variante anhand der Quellen bestätigt.'});});
 await page.getByRole('textbox',{name:'Persönliches Zugriffstoken'}).fill('fixture-only');await page.getByRole('button',{name:'Entsperren',exact:true}).click();await page.getByRole('button',{name:'Auto 1',exact:true}).waitFor();
 ensure(await page.getByRole('columnheader',{name:'1-Stop-Reichweite · EVDB'}).count()===1,'one stop column missing');
 await page.getByRole('button',{name:'Auto 1',exact:true}).click();await page.getByRole('button',{name:'Preise und Zuordnung mit KI korrigieren',exact:true}).click();
 ensure(!(await page.locator('#detail').evaluate(node=>node.open)),'Consent hidden behind modal');await page.getByText('Bitte zuerst die DeepSeek-Beratung über das Kontrollkästchen aktivieren.',{exact:true}).last().waitFor();ensure(writes===0,'Correction ran without consent');
 await page.getByRole('link',{name:'KI-Berater',exact:true}).click();await page.getByRole('heading',{name:'KI-Berater',exact:true}).waitFor();
 ensure(await page.getByRole('button',{name:'Abmelden',exact:true}).count()===1,'Advisor logout missing');
 await page.getByRole('combobox',{name:'Fahrzeug auswählen',exact:true}).selectOption('1');await page.getByRole('button',{name:'Zum Vergleich hinzufügen',exact:true}).click();
 const fill=async(values)=>{for(const [label,value]of Object.entries(values))await page.getByLabel(label,{exact:true}).fill(String(value));};
 await fill({'Haltedauer · Jahre':5,'Jährliche Fahrleistung · km':10000,'Restwert am Ende (Schätzung) · €':15000,'Strompreis zu Hause · €/kWh':.3,'Strompreis öffentlich · €/kWh':0,'Anteil Laden zu Hause · %':100,'Ladeverluste vom Netzbezug · %':0,'Versicherung pro Jahr · €':500,'Kfz-Steuer pro Jahr · €':0,'Wartung und Reparaturen pro Jahr · €':200,'Reifen pro Jahr · €':100,'THG-Erlös pro Jahr (Schätzung) · €':100});
 await page.getByRole('button',{name:'Kosten berechnen',exact:true}).click();ensure((await page.locator('#tco-results').innerText()).includes('21.500,00'),'TCO first car incorrect');
 await page.getByRole('combobox',{name:'Fahrzeug auswählen',exact:true}).selectOption('2');await page.getByRole('button',{name:'Zum Vergleich hinzufügen',exact:true}).click();
 await fill({'Restwert am Ende (Schätzung) · €':20000,'Versicherung pro Jahr · €':600,'Kfz-Steuer pro Jahr · €':0,'Wartung und Reparaturen pro Jahr · €':200,'Reifen pro Jahr · €':100,'THG-Erlös pro Jahr (Schätzung) · €':100});
 await page.getByRole('button',{name:'Kosten berechnen',exact:true}).click();const costs=await page.locator('#tco-results').innerText();ensure(costs.includes('21.500,00')&&costs.includes('27.000,00'),'Vehicle assumptions overwritten');
 await page.getByLabel('Beratung über DeepSeek aktivieren.',{exact:false}).check();await page.getByRole('textbox',{name:'Deine Nachricht',exact:true}).fill('Welches Auto passt?');await page.getByRole('button',{name:'Senden',exact:true}).click();await page.getByText('Beratung abgeschlossen.',{exact:false}).waitFor();ensure(await page.locator('#advisor-history strong').count()>=3,'Chat missing');ensure(await page.locator('#advisor-history script').count()===0,'Unsafe model rendering');
 await page.reload();await page.getByRole('button',{name:'Auto 1',exact:true}).waitFor();await page.getByRole('link',{name:'KI-Berater',exact:true}).click();ensure((await page.locator('#advisor-history').innerText()).includes('Testberatung'),'Chat not persisted');
 await page.getByRole('button',{name:'Kosten berechnen',exact:true}).click();ensure((await page.locator('#tco-results').innerText()).includes('27.000,00'),'TCO inputs not persisted');
 await page.setViewportSize({width:390,height:844});ensure(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Mobile overflow');await page.setViewportSize({width:1280,height:900});
 await page.getByRole('button',{name:'Zur Fahrzeugübersicht',exact:true}).click();await page.getByRole('button',{name:'Auto 1',exact:true}).click();await page.getByRole('button',{name:'Preise und Zuordnung mit KI korrigieren',exact:true}).click();await page.getByText('KI-Korrektur gespeichert',{exact:true}).waitFor();ensure(writes===1,'Correction not applied exactly once');await page.getByRole('button',{name:'Schließen',exact:true}).click();
 await page.getByRole('link',{name:'KI-Berater',exact:true}).click();await page.getByRole('button',{name:'Abmelden',exact:true}).last().click();await page.getByRole('heading',{name:'Dashboard entsperren'}).waitFor();
 return 'PASS: token gate, EVDB ranges, advisor, separate TCO assumptions, chat persistence, safe rendering, mobile layout, direct correction and logout';
}
