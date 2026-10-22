import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

if(existsSync('.env')) process.loadEnvFile('.env');
for(const name of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','DEEPSEEK_API_KEY']) if(!process.env[name]) throw Error(name+' fehlt.');
const run=(args)=>spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{stdio:'inherit',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
const legacy=run(['deploy','--config','wrangler.legacy.jsonc']);
if(legacy.error || legacy.status!==0) throw Error('Der bestehende Kostenrechner konnte nicht unter seiner neuen Adresse bereitgestellt werden. Dashboard-Umstellung gestoppt.');
let available=false;
for(let attempt=0;attempt<8;attempt++) {
  try {const r=await fetch('https://ev-kosten.dinne.beer/',{signal:AbortSignal.timeout(5000)});if(r.ok && (await r.text()).includes('E-Auto Vollkostenrechner')){available=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,3000));
}
if(!available) throw Error('Der bisherige Kostenrechner ist unter ev-kosten.dinne.beer noch nicht erreichbar. Dashboard-Umstellung gestoppt.');
const folder=mkdtempSync(join(tmpdir(),'ev-worker-secrets-'));
try {
  const file=join(folder,'secrets.json');writeFileSync(file,JSON.stringify({DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY}),{mode:0o600});
  const result=run(['deploy','--secrets-file',file]);
  if(result.error) throw Error('Worker-Veröffentlichung konnte nicht gestartet werden.');process.exitCode=result.status??1;
}finally{rmSync(folder,{recursive:true,force:true});}
