'use strict';
// Firefox event-page background. No in-browser scraping: prices come from the
// nightly GitHub Action JSON (gnagster/evdb-apl-sync), downloaded once per day
// into browser.storage.local. content.js reads aplData/aplSettings directly.

// Chrome MV3 has only the callback-based `chrome.*` API, not the promise-based
// `browser.*`. Gated shim covering exactly the methods used below; no-op in
// Firefox (native browser.*) and in Node (no chrome).
if (typeof globalThis !== 'undefined' && !globalThis.browser && typeof chrome !== 'undefined') {
  const promisify = (fn, thisArg) => (...args) =>
    new Promise((resolve, reject) => {
      fn.call(thisArg, ...args, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    });
  globalThis.browser = {
    storage: {
      local: {
        get: promisify(chrome.storage.local.get, chrome.storage.local),
        set: promisify(chrome.storage.local.set, chrome.storage.local),
      },
    },
    runtime: {
      onMessage: chrome.runtime.onMessage,
      onInstalled: chrome.runtime.onInstalled,
      onStartup: chrome.runtime.onStartup,
    },
    alarms: {
      create: chrome.alarms.create.bind(chrome.alarms),
      get: promisify(chrome.alarms.get, chrome.alarms),
      onAlarm: chrome.alarms.onAlarm,
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const SOURCES = [
  'https://raw.githubusercontent.com/gnagster/evdb-apl-sync/main/evdb-apl-prices/apl-prices.json',
  'https://cdn.jsdelivr.net/gh/gnagster/evdb-apl-sync@main/evdb-apl-prices/apl-prices.json',
];
const MODES = ['evdb', 'privatkunden', 'geschaeftskunden'];

const get = (keys) => browser.storage.local.get(keys);
const set = (obj) => browser.storage.local.set(obj);

function isValidData(d) {
  return !!d && typeof d === 'object' &&
    typeof d.generatedAt === 'string' &&
    typeof d.count === 'number' &&
    !!d.prices && typeof d.prices === 'object';
}

async function downloadJson() {
  let lastErr = null;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!isValidData(data)) throw new Error('invalid apl-prices.json shape');
      return data;
    } catch (e) {
      lastErr = e;
      console.warn('apl-prices fetch failed, trying next source:', url, e && e.message);
    }
  }
  throw lastErr || new Error('all sources failed');
}

async function fetchPrices(manual) {
  const st = await get(['aplData', 'aplSettings']);
  const aplSettings = st.aplSettings || { mode: 'evdb', lastRun: null, stats: {} };
  if (!manual && st.aplData && Date.now() - st.aplData.fetchedAt < DAY) {
    return { ok: true, count: Object.keys(st.aplData.prices || {}).length, skipped: true };
  }
  try {
    const data = await downloadJson();
    const aplData = {
      fetchedAt: Date.now(),
      prices: data.prices,
      lowConfidence: Array.isArray(data.lowConfidence) ? data.lowConfidence : [],
    };
    const stats = {
      fetchedAt: aplData.fetchedAt,
      count: Object.keys(aplData.prices).length,
      lowConfidence: aplData.lowConfidence.length,
      lastError: null,
    };
    await set({
      aplData,
      aplSettings: { ...aplSettings, lastRun: aplData.fetchedAt, stats },
    });
    return { ok: true, count: stats.count };
  } catch (e) {
    const lastError = (e && e.message) || String(e);
    const stats = { ...(aplSettings.stats || {}), lastError };
    await set({ aplSettings: { ...aplSettings, stats } });
    return { error: lastError };
  }
}

async function getState() {
  const st = await get(['aplData', 'aplSettings']);
  const aplSettings = st.aplSettings || { mode: 'evdb', lastRun: null, stats: {} };
  if (!MODES.includes(aplSettings.mode)) aplSettings.mode = 'evdb';
  const prices = (st.aplData && st.aplData.prices) || {};
  return {
    settings: aplSettings,
    pricesCount: Object.keys(prices).length,
    fetchedAt: st.aplData ? st.aplData.fetchedAt : null,
    lowConfidenceCount: (st.aplData && st.aplData.lowConfidence) ? st.aplData.lowConfidence.length : 0,
  };
}

browser.runtime.onMessage.addListener(async (msg) => {
  try {
    switch (msg && msg.type) {
      case 'getState':
        return await getState();
      case 'setMode': {
        if (!MODES.includes(msg.mode)) return { error: 'bad mode: ' + msg.mode };
        const { aplSettings = {} } = await get(['aplSettings']);
        await set({ aplSettings: { ...aplSettings, mode: msg.mode } });
        return { ok: true, mode: msg.mode };
      }
      case 'fetchPrices':
        return await fetchPrices(msg.manual === true);
      default:
        return { error: 'unknown:' + (msg && msg.type) };
    }
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
});

// Create once, not on every event-page wake, or each wake re-arms the timer.
async function ensureAlarm() {
  if (!(await browser.alarms.get('refreshDaily'))) {
    browser.alarms.create('refreshDaily', { periodInMinutes: 1440 });
  }
}
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refreshDaily') fetchPrices(false).catch(console.error);
});

async function init() {
  const st = await get(['aplData', 'aplSettings']);
  if (!st.aplSettings) {
    await set({ aplSettings: { mode: 'evdb', lastRun: null, stats: { fetchedAt: null, count: 0, lowConfidence: 0, lastError: null } } });
  } else if (!MODES.includes(st.aplSettings.mode)) {
    // migrate v0.1 'none' mode and any stale value
    await set({ aplSettings: { ...st.aplSettings, mode: 'evdb' } });
  }
  await ensureAlarm();
  if (!st.aplData) fetchPrices(false).catch(console.error);
}

browser.runtime.onInstalled.addListener(init);
browser.runtime.onStartup.addListener(init);
init().catch(console.error);
