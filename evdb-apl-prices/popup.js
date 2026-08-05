'use strict';

// APL Preise – Popup-Steuerung.
// Spricht ausschließlich über chrome.runtime.sendMessage mit dem
// Service Worker (Message-Contract siehe Aufgabenbeschreibung).

const MAX_ROWS = 200;      // Begrenzung der gerenderten Listenzeilen
const POLL_MAX = 120;      // Sekunden, die auf ein fremdes Lauf-Update gewartet wird

const state = {
  settings: null,
  mappingCount: 0,
  cacheCount: 0,
  unmatched: [],
};

const els = {
  statusDot: document.getElementById('statusDot'),
  modeGroup: document.getElementById('modeGroup'),
  runBtn: document.getElementById('runBtn'),
  lastRun: document.getElementById('lastRun'),
  stats: document.getElementById('stats'),
  errLine: document.getElementById('errLine'),
  lastErrLine: document.getElementById('lastErrLine'),
  matchesEmpty: document.getElementById('matchesEmpty'),
  groupManualTitle: document.getElementById('groupManualTitle'),
  groupNoMakeTitle: document.getElementById('groupNoMakeTitle'),
  listManual: document.getElementById('listManual'),
  listNoMake: document.getElementById('listNoMake'),
  truncNote: document.getElementById('truncNote'),
  cacheBtn: document.getElementById('cacheBtn'),
  autoPct: document.getElementById('autoPct'),
};

// sendMessage als Promise; lastError und Exceptions landen als {error}.
function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve({ ok: true, data: res });
      });
    } catch (err) {
      resolve({ error: String(err) });
    }
  });
}

// Transiente Aktionsfehler (Verbindung, Speichern, …). Wird bei jedem
// erfolgreichen refresh() wieder geleert.
function setError(msg) {
  els.errLine.textContent = msg || '';
  els.errLine.hidden = !msg;
}

function relTime(ts) {
  if (ts == null) return 'noch nie';
  const d = Date.now() - ts;
  if (d < 60e3) return 'gerade eben';
  if (d < 3600e3) return 'vor ' + Math.floor(d / 60e3) + ' Min.';
  if (d < 86400e3) return 'vor ' + Math.floor(d / 3600e3) + ' Std.';
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function setModeUI(mode) {
  for (const btn of els.modeGroup.querySelectorAll('button[data-mode]')) {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  }
}

function render() {
  const s = state.settings;
  const st = s.stats || {};

  // Statuspunkt: Fehler vom letzten Abruf oder bereit.
  els.statusDot.className = 'dot ' + (st.lastError ? 'error' : 'idle');
  els.statusDot.title = st.lastError ? 'Letzter Fehler: ' + st.lastError : 'Bereit';

  setModeUI(s.mode);

  els.lastRun.textContent = 'Zuletzt aktualisiert: ' + relTime(s.lastRun);

  if (s.lastRun != null) {
    els.stats.hidden = false;
    const parts = [st.mapped + ' zugeordnet', st.scraped + ' abgerufen'];
    if (st.failed > 0) parts.push(st.failed + ' fehlgeschlagen');
    els.stats.textContent = parts.join(' · ');
  } else {
    els.stats.hidden = true;
  }

  if (st.lastError) {
    els.lastErrLine.textContent = 'Fehler beim letzten Abruf: ' + st.lastError;
    els.lastErrLine.hidden = false;
  } else {
    els.lastErrLine.hidden = true;
  }

  const total = state.mappingCount + state.unmatched.length;
  els.autoPct.textContent = total > 0
    ? Math.round((state.mappingCount / total) * 100) + ' % automatisch zugeordnet'
    : '';

  setError(null); // Erfolgreicher Stand → transiente Fehler räumen
  renderMatches();
}

function renderMatches() {
  const sorted = state.unmatched
    .slice()
    .sort((a, b) => a.make.localeCompare(b.make, 'de') || a.model.localeCompare(b.model, 'de'));

  const manualAll = sorted.filter((u) => u.hasMake);
  const noMakeAll = sorted.filter((u) => !u.hasMake);
  const truncated = sorted.length > MAX_ROWS;
  const visible = truncated ? sorted.slice(0, MAX_ROWS) : sorted;

  els.groupManualTitle.textContent = 'Manuell zuordnen (' + manualAll.length + ')';
  els.groupNoMakeTitle.textContent = 'Marke nicht bei APL (' + noMakeAll.length + ')';
  els.matchesEmpty.hidden = sorted.length > 0;
  els.truncNote.hidden = !truncated;
  if (truncated) {
    els.truncNote.textContent = 'Zeigt die ersten ' + MAX_ROWS + ' von ' + sorted.length + ' Einträgen.';
  }

  buildList(els.listManual, visible.filter((u) => u.hasMake));
  buildList(els.listNoMake, visible.filter((u) => !u.hasMake));
}

function buildList(ul, rows) {
  ul.textContent = '';
  for (const u of rows) {
    const li = document.createElement('li');
    li.className = 'match-row' + (u.hasMake ? '' : ' no-make');
    li.dataset.key = u.key;

    const id = document.createElement('div');
    id.className = 'match-id';
    const make = document.createElement('span');
    make.className = 'make';
    make.textContent = u.make;
    const model = document.createElement('span');
    model.className = 'model';
    model.textContent = u.model;
    id.append(make, model);
    li.append(id);

    if (u.hasMake) {
      const ctrl = document.createElement('div');
      ctrl.className = 'match-controls';
      const hasCandidates = Array.isArray(u.candidates) && u.candidates.length > 0;
      if (hasCandidates) {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', 'APL-Modell für ' + u.make + ' ' + u.model);
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '— nicht zuordnen —';
        sel.append(none);
        for (const slug of u.candidates) {
          const opt = document.createElement('option');
          opt.value = slug;
          opt.textContent = slug;
          sel.append(opt);
        }
        ctrl.append(sel);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small' + (hasCandidates ? '' : ' ghost');
      btn.dataset.action = 'save';
      btn.textContent = hasCandidates ? 'Speichern' : 'Überspringen';
      ctrl.append(btn);
      li.append(ctrl);
    }
    ul.append(li);
  }
}

// --- Aktionen -------------------------------------------------------------

async function refresh() {
  const r = await send({ type: 'getState' });
  if (r.error || !r.data || !r.data.settings) {
    setError('Keine Verbindung zum Hintergrunddienst.');
    return;
  }
  state.settings = r.data.settings;
  state.mappingCount = r.data.mappingCount || 0;
  state.cacheCount = r.data.cacheCount || 0;
  state.unmatched = r.data.unmatched || [];
  render();
}

els.modeGroup.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  const mode = btn.dataset.mode;
  setModeUI(mode); // optimistisch
  const r = await send({ type: 'setMode', mode });
  if (r.error) {
    setError('Preisquelle konnte nicht geändert werden.');
    setModeUI(state.settings ? state.settings.mode : 'none'); // zurücksetzen
    return;
  }
  await refresh();
});

function setRunning(on) {
  els.runBtn.classList.toggle('loading', on);
  els.runBtn.disabled = on;
  const lastErr = state.settings && state.settings.stats && state.settings.stats.lastError;
  els.statusDot.className = 'dot ' + (on ? 'running' : lastErr ? 'error' : 'idle');
  els.statusDot.title = on ? 'Aktualisierung läuft' : 'Bereit';
}

// Läuft bereits ein Update (Antwort {running:true}), wird gepollt, bis
// lastRun sich ändert – getState verrät den laufenden Zustand sonst nicht.
function pollForDone(prevLastRun, triesLeft = POLL_MAX) {
  return new Promise((resolve) => {
    const tick = async () => {
      const r = await send({ type: 'getState' });
      const last = r.data && r.data.settings ? r.data.settings.lastRun : prevLastRun;
      if (last !== prevLastRun || triesLeft <= 0) resolve();
      else setTimeout(tick, 1000);
    };
    tick();
  });
}

els.runBtn.addEventListener('click', async () => {
  if (els.runBtn.disabled) return;
  const prevLastRun = state.settings ? state.settings.lastRun : null;
  setRunning(true);
  const r = await send({ type: 'run', manual: true });
  if (r.error) {
    setRunning(false);
    setError('Aktualisierung fehlgeschlagen.');
    return;
  }
  if (r.data && r.data.running) await pollForDone(prevLastRun);
  setRunning(false);
  await refresh();
});

function handleListAction(e) {
  const btn = e.target.closest('button[data-action="save"]');
  if (!btn) return;
  const li = btn.closest('li.match-row');
  const sel = li.querySelector('select');
  const slug = sel ? sel.value || null : null; // leere Auswahl = explizit überspringen
  saveOverride(li.dataset.key, slug);
}

els.listManual.addEventListener('click', handleListAction);
els.listNoMake.addEventListener('click', handleListAction);

async function saveOverride(key, slug) {
  const r = await send({ type: 'setOverride', key, slug });
  if (r.error) {
    setError('Zuordnung konnte nicht gespeichert werden.');
    return;
  }
  // Optimistisch entfernen, dann Hintergrund-Sync.
  state.unmatched = state.unmatched.filter((u) => u.key !== key);
  renderMatches();
  await refresh();
}

els.cacheBtn.addEventListener('click', async () => {
  if (!confirm('Gespeicherte APL-Preise wirklich löschen?')) return;
  const r = await send({ type: 'clearCache' });
  if (r.error) setError('Cache konnte nicht geleert werden.');
  else await refresh();
});

document.addEventListener('DOMContentLoaded', refresh);
