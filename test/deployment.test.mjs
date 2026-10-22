import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkSite} from '../tools/check-site.mjs';
test('deployment accepts only healthy content or an explicit Cloudflare challenge; calculator origin must remain healthy',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response('Calculator');assert.deepEqual(await checkSite('https://example.com','Calculator'),{challenge:false});
    for(const r of [new Response('Wrong app'),new Response('Blocked',{status:403}),new Response('Failed',{status:500})]){globalThis.fetch=async()=>r;await assert.rejects(checkSite('https://example.com','Calculator'));}
    const challenge=()=>new Response('Challenge',{status:403,headers:{'cf-mitigated':'challenge'}});
    globalThis.fetch=async(url)=>url.endsWith('/origin')?new Response('Calculator'):challenge();
    assert.deepEqual(await checkSite('https://example.com','Calculator','https://example.com/origin'),{challenge:true});
    globalThis.fetch=async()=>challenge();await assert.rejects(checkSite('https://example.com','Calculator','https://example.com/origin'));
    assert.deepEqual(await checkSite('https://example.com','Dashboard'),{challenge:true});
  }finally{globalThis.fetch=original;}
});
