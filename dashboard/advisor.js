'use strict';
(function(global) {
  const STORE='ev-advisor:'+REPO+':v1';
  let state={messages:[],profile:{},vehicleProfiles:{},selected:[],consent:false,notes:''},active=null,usage={input:0,output:0};
  try {const value=JSON.parse(localStorage.getItem(STORE)||'null');if(value && Array.isArray(value.messages) && value.profile && Array.isArray(value.selected)) state={...state,...value,messages:value.messages.filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string').slice(-40)};}catch{}
  const inputs={};
  if(state.profile.homeSharePercent==null && state.profile.homeShare!=null) state.profile.homeSharePercent=state.profile.homeShare;
  for(const values of Object.values(state.vehicleProfiles)) if(values.homeSharePercent==null && values.homeShare!=null) values.homeSharePercent=values.homeShare;
  const shared=['years','annualKm','homePrice','publicPrice','homeSharePercent','lossPercent','requirements'];
  let editingId=state.selected[0]||'';
  const saveState=()=>{try{localStorage.setItem(STORE,JSON.stringify(state));}catch{$('advisor-status').textContent='Der Browser konnte den Verlauf nicht speichern.';}};
  function switchTab(advisor) {
    $('advisor').hidden=!advisor;$('price-workspace').hidden=advisor;
    for(const a of document.querySelectorAll('.sidebar nav a')) a.classList.toggle('active',advisor?a.id==='advisor-tab':a.getAttribute('href')==='#overview');
    if(advisor) $('advisor-message').focus();
  }
  function rich(text) {
    const node=el('div',undefined,'chat-text');let index=0;
    for(const match of text.matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g)) {
      node.append(document.createTextNode(text.slice(index,match.index)));
      if(match[3]) node.append(el('strong',match[3]));
      else {try{const u=new URL(match[2]);if(u.username||u.password) throw Error();const link=el('a',match[1]);link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';node.append(link);}catch{node.append(document.createTextNode(match[0]));}}
      index=match.index+match[0].length;
    }
    node.append(document.createTextNode(text.slice(index)));return node;
  }
  function renderHistory() {
    $('advisor-history').replaceChildren();
    for(const message of state.messages) {const article=el('article',undefined,'chat-message '+message.role);article.append(el('strong',message.role==='user'?'Du':'EV-Berater'),rich(message.content));$('advisor-history').append(article);}
  }
  function currentRows() {return data && database?E.rows(database,effective(),draft,{},D.money):[];}
  function selectedVehicles() {return state.selected.map(id=>currentRows().find(([key])=>key==='evdb:'+id)?.[1]).filter(Boolean);}
  function renderSelection() {
    $('tco-selection').replaceChildren();
    for(const v of selectedVehicles()) $('tco-selection').append(button(v.title+' ×',()=>{storeInputs();state.selected=state.selected.filter(id=>id!==v.id);if(editingId===v.id)editingId=state.selected[0]||'';saveState();renderSelection();fillProfile();}));
    $('tco-input-vehicle').replaceChildren(new Option('Gemeinsame Vorgaben',''),...selectedVehicles().map(v=>new Option(v.title,v.id)));$('tco-input-vehicle').value=editingId;
  }
  function onLoad() {
    const selected=$('tco-vehicle').value;
    $('tco-vehicle').replaceChildren(new Option('Fahrzeug auswählen',''),...currentRows().sort((a,b)=>a[1].title.localeCompare(b[1].title,'de')).map(([,v])=>new Option(v.title+' · '+(v.priceEur==null?'Preis unbekannt':eur.format(v.priceEur)),v.id)));
    $('tco-vehicle').value=selected;renderSelection();
  }
  function profile(id=editingId) {
    if(id!==editingId)return {...state.profile,...state.vehicleProfiles[id]};
    const p={...state.profile,...state.vehicleProfiles[id],financed:$('tco-financed').checked,requirements:$('advisor-requirements').value};
    for(const [key,input] of Object.entries(inputs)) p[key]=input.value===''?null:Number(input.value);
    return p;
  }
  function storeInputs() {
    const p=profile();
    for(const key of shared)state.profile[key]=p[key];
    if(editingId)state.vehicleProfiles[editingId]=Object.fromEntries(Object.entries(p).filter(([key])=>!shared.includes(key)));
    else state.profile=p;
    saveState();
  }
  function renderTco(vehicle,result,assumed=false) {
    const card=el('article',undefined,'tco-result');
    card.append(button(vehicle.title+' · Details',()=>openDetail('evdb:'+vehicle.id),'model-button'));
    card.append(el('p',(vehicle.priceSource||'')+' · '+(vehicle.priceEur==null?'Preis unbekannt':eur.format(vehicle.priceEur))+' · EVDB '+vehicle.rangeKm+' km / 1 Stop '+vehicle.stopRangeKm+' km','muted'));
    if(assumed) card.append(el('p','KI-Rechenannahmen: Bitte die übernommenen Eingaben und Quellen prüfen.','detail-note'));
    if(result.total==null) card.append(el('p','Noch offen: '+result.missing.join(', '),'notice error'));
    else {const summary=el('div',undefined,'tco-summary');for(const [label,value] of [['Gesamt',eur.format(result.total)],['Pro Monat',eur.format(result.monthly)],['Pro km',eur.format(result.perKm)]]) {const box=el('div');box.append(el('small',label),el('strong',value));summary.append(box);}card.append(summary);}
    const table=el('table'),caption=el('caption','Kosten über '+(result.years||'…')+' Jahre');table.append(caption);
    for(const item of result.items) {const row=el('tr');row.append(el('th',item.label),el('td',item.value==null?'Offen':eur.format(item.value)));table.append(row);}card.append(table);
    if(result.total==null) card.append(el('p','Bisher berechenbare Positionen: '+eur.format(result.partialTotal)+' – kein vollständiger Gesamtbetrag.','muted'));
    if(result.monthlyPayment) card.append(el('p','Kreditrate: '+eur.format(result.monthlyPayment)+' / Monat · Restschuld am Ende: '+eur.format(result.remainingDebt)+'. Tilgung ist kein zusätzlicher TCO-Kostenposten.'));
    $('tco-results').append(card);
  }
  function calculate() {
    $('tco-error').textContent='';$('tco-results').replaceChildren();
    try {
      storeInputs();state.notes=$('tco-notes').value;saveState();
      const vehicles=selectedVehicles();if(!vehicles.length) throw Error('Bitte mindestens ein Fahrzeug zum Vergleich hinzufügen.');
      for(const v of vehicles) {
        const values=profile(v.id),result=EVTCO.calculate(v,values);renderTco(v,result);
        if(result.total!=null) {
          const low=EVTCO.calculate(v,{...values,resale:values.resale*.8,thg:0});
          $('tco-results').lastChild.append(el('p','Sensitivität, keine Prognose: Bei 20 % weniger Restwert und ohne THG betragen die Kosten '+eur.format(low.monthly)+' pro Monat.','detail-note'));
        }
      }
    }catch(e){$('tco-error').textContent=e.message;}
  }
  async function request(path,body,onEvent,signal) {
    if(!token) throw Error('Bitte zuerst das Dashboard entsperren.');
    const response=await fetch('/api/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    if(!response.ok) {let value;try{value=await response.json();}catch{}if(response.status===401) lock(true,'Sitzung abgelaufen. Bitte neu entsperren.');throw Error(value?.error||'KI-Anfrage fehlgeschlagen ('+response.status+').');}
    if(response.headers.get('Content-Type')?.includes('application/json')) return response.json();
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(true) {const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line){const event=JSON.parse(line);if(event.type==='error') throw Error(event.message);await onEvent(event);}}if(done)break;}
  }
  function consent() {
    if(!state.consent) {
      if($('detail').open)$('detail').close();switchTab(true);$('advisor-consent').focus();
      const message='Bitte zuerst die DeepSeek-Beratung über das Kontrollkästchen aktivieren.';$('advisor-status').textContent=message;throw Error(message);
    }
  }
  async function operation(action) {
    if(active) throw Error('Es läuft bereits eine KI-Anfrage. Bitte warten oder abbrechen.');
    consent();const controller=new AbortController();active=controller;$('advisor-stop').disabled=false;$('advisor-send').disabled=true;
    try{return await action(controller.signal);}
    catch(e){if(e.name==='AbortError') throw Error('KI-Anfrage abgebrochen.');throw e;}
    finally{if(active===controller)active=null;$('advisor-stop').disabled=true;$('advisor-send').disabled=false;}
  }
  async function send() {
    const text=$('advisor-message').value.trim();if(!text) return;
    await operation(async(signal)=>{
      storeInputs();state.messages.push({role:'user',content:text});state.messages=state.messages.slice(-40);$('advisor-message').value='';renderHistory();saveState();let receivedTco=false;
      $('advisor-status').textContent='Beratung wird gestartet …';
      const history=[];let chars=0;for(const message of [...state.messages].reverse()){const content=message.content.slice(0,12000);if(chars+content.length>60000)break;history.unshift({role:message.role,content});chars+=content.length;}
      await request('chat',{messages:history,profile:{...state.profile,vehicleProfiles:state.vehicleProfiles},filters:$('advisor-use-filters').checked?filters():{},draft},event=>{
        if(event.type==='status') $('advisor-status').textContent=event.text;
        if(event.type==='usage') {usage.input+=event.prompt_tokens||0;usage.output+=event.completion_tokens||0;$('advisor-usage').textContent='Diese Sitzung: '+usage.input+' Eingabe- / '+usage.output+' Ausgabe-Tokens';}
        if(event.type==='answer') {
          const sources=(event.sources||[]).filter((s,i,list)=>s.url && list.findIndex(x=>x.url===s.url)===i).slice(0,12);
          const answer=event.text+(sources.length?'\n\nGelesene / gefundene Quellen:\n'+sources.map(s=>'['+(s.title||s.url).replace(/[\[\]]/g,'')+']('+s.url+')').join('\n'):'');
          state.messages.push({role:'assistant',content:answer});state.messages=state.messages.slice(-40);saveState();renderHistory();
        }
        if(event.type==='tco') {
          for(const key of shared)if(event.inputs[key]!=null)state.profile[key]=event.inputs[key];
          state.vehicleProfiles[event.vehicle.id]={...state.vehicleProfiles[event.vehicle.id],...Object.fromEntries(Object.entries(event.inputs).filter(([key])=>!shared.includes(key)))};
          editingId=event.vehicle.id;fillProfile();state.selected=[...new Set([...state.selected,event.vehicle.id])].slice(-3);saveState();renderSelection();if(!receivedTco)$('tco-results').replaceChildren();receivedTco=true;renderTco(event.vehicle,event.result,true);
        }
      },signal);
      $('advisor-status').textContent='Beratung abgeschlossen. Du kannst Rückfragen stellen oder die Kostenannahmen anpassen.';
    });
  }
  function fillProfile() {
    const values={...state.profile,...state.vehicleProfiles[editingId]};
    for(const [key,input] of Object.entries(inputs)) input.value=values[key]??EVTCO.fields.find(f=>f[0]===key)[3]??'';
    $('tco-financed').checked=!!values.financed;$('advisor-requirements').value=state.profile.requirements||'';$('tco-notes').value=state.notes||'';
    for(const key of ['downPayment','loanMonths','interestPercent','balloon','loanFees']) inputs[key].parentElement.hidden=!values.financed;
  }
  function discuss(id) {
    storeInputs();editingId=id;if($('detail').open) $('detail').close();switchTab(true);state.selected=[...new Set([...state.selected,id])].slice(-3);saveState();renderSelection();fillProfile();
    const v=database.vehicles.find(v=>v.id===id);$('advisor-message').value='Berate mich zu '+v.title+' (EVDB '+id+'): Passt dieses Fahrzeug zu meinen Anforderungen und wie hoch sind seine Gesamtkosten?';
  }
  async function correct(id) {
    if(dirty()) throw Error('Bitte zuerst die offenen Entwürfe speichern oder verwerfen.');
    await operation(async(signal)=>{
      const detail=$('detail-content'),status=el('section',undefined,'detail-note');
      const text=el('p','KI-Prüfung wird gestartet …');status.append(text,el('p','Bei erfolgreicher Prüfung werden die Zuordnung und auch eigene Preiswerte dieses Fahrzeugs durch bestätigte APL-Werte ersetzt.'),button('KI-Prüfung abbrechen',()=>active?.abort()));detail.prepend(status);
      let proposal,answer,refresh;const refreshed=new Set();
      for(let pass=0;pass<4;pass++) {
        refresh=null;
        await request('vehicle-check',{vehicleId:id},event=>{
          if(event.type==='status')text.textContent=event.text;
          if(event.type==='proposal')proposal=event;
          if(event.type==='answer')answer=event.text;
          if(event.type==='refresh')refresh=event.slug;
        },signal);
        if(!refresh)break;
        if(refreshed.has(refresh))throw Error('APL-Quelle konnte nicht frisch geladen werden. Bisherige Preise bleiben erhalten.');
        refreshed.add(refresh);text.textContent='Frische APL-Angebote werden über GitHub Actions geladen …';
        const run=await dispatch('catalogue',refresh);
        while(!run.done) {signal.throwIfAborted();text.textContent=run.status;await new Promise((resolve,reject)=>{const timeout=setTimeout(resolve,1500);signal.addEventListener('abort',()=>{clearTimeout(timeout);reject(new DOMException('Abgebrochen','AbortError'));},{once:true});});}
        if(run.needsResults || /Fehlgeschlagen|konnte nicht/.test(run.status))throw Error(run.status);
      }
      if(!proposal) {text.textContent=answer||'Kein eindeutig bestätigtes Angebot gefunden. Keine Änderung gespeichert.';return;}
      signal.throwIfAborted();text.textContent='Quellen werden abschließend geprüft und die Korrektur wird gespeichert …';
      const result=await request('vehicle-correction',proposal,()=>{},signal);
      requests.unshift({commit:result.commit,label:'KI-Korrektur: '+id,status:'Preisübernahme angefordert',url:result.url});
      await load();openDetail('evdb:'+id);const summary=el('section',undefined,'detail-note');summary.append(el('strong','KI-Korrektur gespeichert'),el('p','Vorher: '+eur.format(result.before.priceEur)+' · Jetzt: '+amount(result.after.endpreis)),el('p',result.reason));
      const link=el('a','Korrektur-Commit öffnen ↗');link.href=result.url;link.target='_blank';link.rel='noopener';summary.append(link);$('detail-content').prepend(summary);renderRuns();pollRuns();
    });
  }
  for(const [key,label,unit,def,min,max] of EVTCO.fields) {
    const wrapper=el('label',label+' · '+unit),input=el('input');input.type='number';input.min=min;input.max=max;input.step=key==='loanMonths'?'1':'any';input.value=state.profile[key]??def??'';wrapper.append(input);inputs[key]=input;$('tco-inputs').append(wrapper);
    input.onchange=storeInputs;
  }
  $('advisor-tab').onclick=()=>{switchTab(true);};
  for(const a of document.querySelectorAll('.sidebar nav a')) if(a.id!=='advisor-tab') a.addEventListener('click',()=>switchTab(false));
  $('advisor-back').onclick=()=>switchTab(false);
  $('advisor-logout').onclick=()=> $('connect').onclick();
  $('advisor-consent').checked=state.consent;
  $('advisor-consent').onchange=()=>{state.consent=$('advisor-consent').checked;if(!state.consent)active?.abort();saveState();};
  $('advisor-requirements').onchange=storeInputs;
  $('tco-notes').onchange=()=>{state.notes=$('tco-notes').value;saveState();};
  $('tco-financed').onchange=()=>{storeInputs();fillProfile();};
  $('tco-input-vehicle').onchange=()=>{storeInputs();editingId=$('tco-input-vehicle').value;fillProfile();};
  $('tco-add').onclick=()=>{const id=$('tco-vehicle').value;if(!id)return;if(state.selected.length>=3&&!state.selected.includes(id)){$('tco-error').textContent='Bitte höchstens drei Fahrzeuge gleichzeitig vergleichen.';return;}storeInputs();state.selected=[...new Set([...state.selected,id])];editingId=id;saveState();renderSelection();fillProfile();};
  $('tco-calculate').onclick=calculate;
  $('advisor-form').onsubmit=event=>{event.preventDefault();send().catch(e=>{$('advisor-status').textContent=e.message;});};
  $('advisor-stop').onclick=()=>active?.abort();
  $('advisor-clear').onclick=()=>{if(!confirm('Gespräch, Anforderungen und alle TCO-Eingaben in diesem Browser löschen?'))return;active?.abort();state={messages:[],profile:{},vehicleProfiles:{},selected:[],consent:false,notes:''};editingId='';localStorage.removeItem(STORE);fillProfile();$('advisor-consent').checked=false;$('tco-results').replaceChildren();renderHistory();renderSelection();$('advisor-status').textContent='Lokaler Verlauf und Profil gelöscht.';};
  function onLock(){active?.abort();$('advisor-history').replaceChildren();$('tco-results').replaceChildren();}
  global.EVAdvisor={onLoad:()=>{onLoad();renderHistory();},onLock,discuss,correct};
  fillProfile();renderHistory();if(data)onLoad();
})(globalThis);
