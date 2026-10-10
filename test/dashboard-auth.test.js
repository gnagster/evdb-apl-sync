'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const D = require('../dashboard/core.js');
const app = fs.readFileSync(require.resolve('../dashboard/app.js'), 'utf8');
const KEY = 'apl-dashboard:gnagster/evdb-apl-sync:token';
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

class Element {
  constructor() { this.value = '';this.hidden = false;this.children = [];this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setCustomValidity() {}
  setAttribute(name,value) { this[name] = value; }
  focus() {}
  close() { this.open = false; }
  addEventListener() {}
}
function browser(storage = new Map(), state = {}) {
  const nodes = new Map(), calls = [];
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element());return nodes.get(id); };
  get('dashboard').hidden = true;
  const context = vm.createContext({
    APLDashboard: D, EVDB: require('../dashboard/evdb.js'), document: { getElementById: get, querySelectorAll: () => [], createElement: () => new Element() },
    window: { addEventListener() {} }, Option: Element, TextEncoder, TextDecoder, Uint8Array, URL,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: { randomUUID: () => 'fixture-request' }, confirm: () => { state.confirmCalls = (state.confirmCalls || 0) + 1;return true; }, setTimeout() {},
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => { if (state.blockStorage) throw Error('blocked');storage.set(key, value); },
      removeItem: (key) => storage.delete(key)
    },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      const dispatch = url.includes('/dispatches');
      const status = state.status || (dispatch ? 204 : 200);
      if (url.endsWith('/evdb-apl-sync') && state.validate) await state.validate;
      let value;
      if (url.endsWith('/evdb-apl-sync')) value = { permissions: { push: state.push !== false } };
      else if (url.includes('/commits/main')) value = { sha: 'fixture' };
      else if (url.includes('/contents/')) value = { sha: 'blob', content: Buffer.from(JSON.stringify(D.empty())).toString('base64') };
      else if (url.includes('/dispatches')) value = null;
      else if (url.includes('/actions/workflows/')) value = { workflow_runs: state.runs || [] };
      else if (url.endsWith('/scrape-cache.json')) { if (state.cacheWait) await state.cacheWait;value = state.cache || { slugLines: {}, motorSpecs: {}, lineData: {} }; }
      else if (url.endsWith('/evdb-vehicles.json')) value = { vehicles: [{id:'1',make:'Test',model:'Car',title:'Test Car',status:'current',tokens:[],priceEur:25000}], filters: {groups:{},ranges:[]} };
      else if (url.endsWith('/apl-prices.json')) {
        if (state.priceWait) await state.priceWait;
        value = { count: 1, prices: { 'Test|Car': { endpreis: '25.000,00', confidence: 1, offers: [] } }, appliedOverrides: D.empty(), modelUrls: {} };
      } else throw Error('Unexpected request: ' + url);
      return { ok: status >= 200 && status < 300, status, json: async () => value };
    }
  });
  vm.runInContext(app, context);
  const login = async (value) => { get('token').value = value;get('auth-form').onsubmit({ preventDefault() {} });await settle(); };
  return { get, calls, login, storage, evaluate: (code) => vm.runInContext(code, context) };
}
(async () => {
  let b = browser();await settle();
  assert.equal(b.get('dashboard').hidden, true);
  assert.equal(b.calls.length, 0, 'locked page must not fetch any prices or repo data');
  await b.login('valid-fixture-token');
  assert.equal(b.get('dashboard').hidden, false);
  assert.equal(b.get('auth').hidden, true);
  assert.equal(b.storage.get(KEY), 'valid-fixture-token');
  assert.equal(b.calls[0].url, 'https://api.github.com/repos/gnagster/evdb-apl-sync');
  assert.equal(b.calls[0].opts.headers.Authorization, 'Bearer valid-fixture-token');
  assert.equal(b.get('token').value, '', 'token must not stay in the visible form');

  let release;
  const state = { validate: new Promise((resolve) => { release = resolve; }) };
  const reopened = browser(b.storage, state);await settle();
  assert.equal(reopened.get('dashboard').hidden, true, 'saved token must be revalidated before showing data');
  assert.equal(reopened.calls.length, 1, 'no price fetch while validation is pending');
  release();await settle();
  assert.equal(reopened.get('dashboard').hidden, false);
  reopened.get('connect').onclick();
  assert.equal(reopened.get('dashboard').hidden, true);
  assert.equal(reopened.storage.has(KEY), false);
  assert.equal(reopened.get('rows').children.length, 0);
  b = browser(reopened.storage);await settle();assert.equal(b.calls.length, 0, 'logout survives reopening');

  for (const denied of [{ status: 401 }, { push: false }]) {
    b = browser(new Map([[KEY, 'invalid-fixture-token']]), denied);await settle();
    assert.equal(b.get('dashboard').hidden, true);
    assert.equal(b.storage.has(KEY), false);
    assert.equal(b.calls.length, 1, 'rejected token must not load prices');
    assert.equal(b.get('auth-message').hidden, false);
  }
  const expire = {};
  b = browser(new Map([[KEY, 'valid-fixture-token']]), expire);await settle();
  expire.status = 401;b.get('reload').onclick();await settle();
  assert.equal(b.get('dashboard').hidden, true, 'expired session must lock an already open dashboard');
  assert.equal(b.storage.has(KEY), false);

  b = browser(new Map(), { blockStorage: true });await b.login('valid-fixture-token');
  assert.equal(b.get('dashboard').hidden, true);
  assert.equal(b.calls.length, 1, 'blocked storage is reported before loading prices');

  const transientStorage = new Map([[KEY, 'valid-fixture-token']]);
  b = browser(transientStorage, { status: 503 });await settle();
  assert.equal(b.get('dashboard').hidden, true);
  assert.equal(transientStorage.has(KEY), true, 'temporary outages must not erase a saved token');

  const pending = { priceWait: new Promise((resolve) => { release = resolve; }) };
  b = browser(new Map([[KEY, 'valid-fixture-token']]), pending);await settle();
  b.get('connect').onclick();release();await settle();
  assert.equal(b.get('dashboard').hidden, true, 'in-flight responses must not unlock after logout');
  assert.equal(b.storage.has(KEY), false);
  const catalogueState = { runs: [{ id: 42, display_title: 'APL catalogue fixture-request', html_url: 'https://github.com/fixture/run/42', status: 'queued' }] };
  b = browser(new Map(), catalogueState);await b.login('valid-fixture-token');
  b.get('detail').open = true;b.get('unsaved-price').value = '21.234,00';
  b.evaluate(`draft.mapping['evdb:1'] = {evdbOnly:true};globalThis.refreshCount=0;
    sourceViews=[{model:{value:'ariya'},status:document.createElement('div'),loadButton:document.createElement('button'),grid:document.createElement('div'),refresh:()=>{globalThis.refreshCount++}}];`);
  await b.evaluate("dispatch('catalogue','ariya')");await settle();
  assert.equal(catalogueState.confirmCalls || 0,0,'catalogue loading allows dirty drafts without discard confirmation');
  assert.equal(b.evaluate('sourceViews[0].loadButton.disabled'),true);
  assert.match(b.evaluate('sourceViews[0].status.children[0].textContent'),/Warteschlange/);
  await b.evaluate("dispatch('catalogue','ariya')");
  assert.equal(b.calls.filter(c=>c.url.includes('/dispatches')).length,1,'duplicate clicks share a pending request');
  catalogueState.cache = {slugLines:{ariya:{lines:[{id:'49',name:'New trim'}]}},lineData:{49:{data:{offers:{}}}},motorSpecs:{}};
  catalogueState.runs[0].status='completed';catalogueState.runs[0].conclusion='success';
  await b.evaluate('pollRuns()');
  assert.equal(b.evaluate('cache.slugLines.ariya.lines[0].name'),'New trim');
  assert.equal(b.evaluate('refreshCount'),1);assert.equal(b.evaluate('sourceViews[0].loadButton.disabled'),false);
  assert.match(b.evaluate('sourceViews[0].status.children[0].textContent'),/Auswahl kann fortgesetzt/);
  assert.equal(b.evaluate("draft.mapping['evdb:1'].evdbOnly"),true);
  assert.equal(b.get('unsaved-price').value,'21.234,00','raw edit fields stay untouched');
  assert.equal(b.get('detail').open,true);assert.equal(b.evaluate('fileSha'),'blob','source refresh must not overwrite conflict baseline');
  catalogueState.runs[0].conclusion='failure';
  b.evaluate('requests[0].done=false');await b.evaluate('pollRuns()');
  assert.equal(b.evaluate('refreshCount'),1,'failed runs must not reload cache');
  assert.match(b.evaluate('sourceViews[0].status.children[0].textContent'),/Fehlgeschlagen/);
  catalogueState.runs[0].conclusion='success';catalogueState.cache.lineData={};
  b.evaluate('requests[0].done=false');await b.evaluate('pollRuns()');
  assert.equal(b.evaluate('cache.slugLines.ariya.lines[0].name'),'New trim','bad results keep prior cache');
  assert.equal(b.evaluate('requests[0].needsResults'),true);
  assert.equal(b.evaluate('sourceViews[0].loadButton.textContent'),'Ergebnisse erneut laden');
  catalogueState.cacheWait=new Promise(resolve=>{release=resolve;});
  const late=b.evaluate('refreshCatalogue(requests[0])').catch(e=>e.message);await settle();
  b.get('connect').onclick();release();assert.match(await late,/Sitzung wurde beendet/);
  assert.equal(b.get('dashboard').hidden,true,'late source results cannot revive logout');
  console.log('PASS: token persistence, gated loading, revalidation, expiry, logout and request races; inline catalogue status, completion, draft preservation and failures');
})().catch((error) => { console.error(error);process.exitCode = 1; });
