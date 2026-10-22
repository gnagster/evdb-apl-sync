import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkSite} from './check-site.mjs';

if(existsSync('.env')) process.loadEnvFile('.env');
for(const name of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','DEEPSEEK_API_KEY']) if(!process.env[name]) throw Error(name+' fehlt.');
const run=(args)=>spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
const legacy=run(['deploy','--config','wrangler.legacy.jsonc']);
if(legacy.error || legacy.status!==0) throw Error('Der bestehende Kostenrechner konnte nicht unter seiner neuen Adresse bereitgestellt werden. Dashboard-Umstellung gestoppt.');
let available=false,lastFailure='';
for(let attempt=0;attempt<8;attempt++) {
  try {const result=await checkSite('https://ev-kosten.dinne.beer/','E-Auto Vollkostenrechner','https://ev-kostenrechner.pages.dev/');if(result.challenge)console.log('Cloudflare verlangt von diesem Runner eine Browserprüfung. Ursprung des bisherigen Rechners erfolgreich geprüft.');available=true;break;}catch(e){lastFailure=e.cause?.code||e.message;}
  await new Promise(resolve=>setTimeout(resolve,3000));
}
if(!available) throw Error('Der bisherige Kostenrechner ist unter ev-kosten.dinne.beer noch nicht erreichbar ('+lastFailure+'). Dashboard-Umstellung gestoppt.');
const folder=mkdtempSync(join(tmpdir(),'ev-worker-secrets-'));
try {
  const file=join(folder,'secrets.json');writeFileSync(file,JSON.stringify({DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY}),{mode:0o600});
  const result=run(['deploy','--secrets-file',file]);
  if(result.error) throw Error('Worker-Veröffentlichung konnte nicht gestartet werden.');process.exitCode=result.status??1;
  if(result.status===0) {
    const health=await checkSite('https://ev.dinne.beer/','APL · Preisübersicht');
    console.log(health.challenge?'Worker erfolgreich veröffentlicht. Cloudflare verlangt vom Runner eine Browserprüfung; die öffentliche Oberfläche zusätzlich im Browser prüfen.':'Dashboard-Domain erfolgreich geprüft.');
  }
}finally{rmSync(folder,{recursive:true,force:true});}
