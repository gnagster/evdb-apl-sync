'use strict';
const D = APLDashboard, $ = (id) => document.getElementById(id);
const REPO = 'gnagster/evdb-apl-sync', API = 'https://api.github.com/repos/' + REPO;
let token = '', data, cache, saved = D.empty(), draft = D.empty(), fileSha = '', page = 0;
let sort = 'model', direction = 1, selectedKey = '', visibleRows = [], requests = [], polling = false;
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const date = (value) => value ? new Date(value).toLocaleString('de-DE') : 'unbekannt';
const amount = (value) => D.money(value) === null ? '—' : eur.format(D.money(value));
const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className) {
  const node = el('button', text, className); node.type = 'button';
  node.addEventListener('click', () => Promise.resolve().then(action).catch(showError)); return node;
}
function notice(message, error = false) {
  for (const node of [$('message'), ...document.querySelectorAll('dialog[open] .notice')]) {
    node.hidden = false;node.textContent = message;node.classList.toggle('error', error);
  }
}
function showError(error) { notice(error.message || String(error), true); }
async function api(path, options = {}) {
  const response = await fetch(API + path, { ...options, headers: {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {})
  }, cache: 'no-store' });
  if (!response.ok) {
    const messages = { 401: 'Das Token ist ungültig oder abgelaufen.', 403: 'GitHub verweigert den Zugriff. Prüfe die Token-Rechte und das API-Limit.',
      409: 'Die Datei wurde zwischenzeitlich geändert. Deine Entwürfe bleiben erhalten. Exportiere sie oder lade den aktuellen Stand.',
      422: 'GitHub konnte die Anfrage nicht übernehmen. Bitte den aktuellen Stand laden und erneut versuchen.' };
    throw new Error(messages[response.status] || 'GitHub-Anfrage fehlgeschlagen (' + response.status + ').');
  }
  return response.status === 204 ? null : response.json();
}
async function load() {
  if (dirty() && !confirm('Ungespeicherte Entwürfe verwerfen und neu laden?')) return;
  $('reload').disabled = true;
  try {
    const commit = await api('/commits/main');
    const raw = 'https://raw.githubusercontent.com/' + REPO + '/' + commit.sha + '/';
    const read = async (path) => {
      const response = await fetch(raw + path, { cache: 'no-store' });
      if (!response.ok) throw new Error('Daten konnten nicht geladen werden: ' + path);
      return response.json();
    };
    const [prices, scrapeCache, configFile] = await Promise.all([
      read('apl-prices.json'), read('tools/scrape-cache.json'), api('/contents/tools/dashboard-overrides.json?ref=' + commit.sha)
    ]);
    if (!prices.prices || typeof prices.count !== 'number') throw new Error('Ungültige Preisdatei.');
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(configFile.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
    saved = D.validate(JSON.parse(decoded)); draft = D.clone(saved); fileSha = configFile.sha;
    data = prices; cache = scrapeCache;
    const makes = [...new Set(Object.keys(data.prices).map((k) => k.split('|')[0]))].sort((a, b) => a.localeCompare(b, 'de'));
    const currentMake = $('make').value;
    $('make').replaceChildren(new Option('Alle Hersteller', ''), ...makes.map((m) => new Option(m, m)));
    $('make').value = makes.includes(currentMake) ? currentMake : '';
    page = 0; render();
    if (!data.modelUrls) notice('Die Quellenübersicht wird beim nächsten vollständigen Abruf ergänzt.');
    else if (JSON.stringify(saved) !== JSON.stringify(data.appliedOverrides)) notice('Korrekturen sind gespeichert. Die Übernahme in die Preisdatei läuft noch.');
    else if (data.warnings?.length) notice(data.warnings.join('\n'), true);
    else $('message').hidden = true;
  } finally { $('reload').disabled = false; }
}
function effective() {
  let prices = D.rawPrices(data);
  try { prices = D.applyMappings(prices, draft, cache); }
  catch { /* Saved assignment may be waiting for its targeted source fetch. */ }
  return D.applyPrices(prices, draft).prices;
}
function filters() {
  const min = $('min-price').value.trim(), max = $('max-price').value.trim();
  $('min-price').setCustomValidity(min && D.money(min) === null ? 'Bitte einen gültigen Eurobetrag eingeben.' : '');
  $('max-price').setCustomValidity(max && D.money(max) === null ? 'Bitte einen gültigen Eurobetrag eingeben.' : '');
  return { query: $('query').value, make: $('make').value, tag: $('tag').value,
    min: min ? D.money(min) : null, max: max ? D.money(max) : null,
    uncertain: $('uncertain').checked, corrected: $('corrected').checked, sort, direction };
}
function render() {
  if (!data) return;
  const prices = effective();
  visibleRows = D.filterRows(prices, draft, filters());
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / 50)); page = Math.min(page, totalPages - 1);
  $('updated').textContent = 'Letzter Datenabruf: ' + date(data.generatedAt);
  $('vehicle-count').textContent = Object.keys(prices).length;
  $('offer-count').textContent = Object.values(prices).reduce((n, p) => n + (p.offers || []).length, 0);
  $('uncertain-count').textContent = Object.values(prices).filter((p) => p.confidence < .85).length;
  const correctedKeys = [...new Set([...Object.keys(draft.mapping), ...Object.keys(draft.prices)])];
  $('correction-count').textContent = correctedKeys.length;
  $('result-count').textContent = visibleRows.length + ' von ' + Object.keys(prices).length + ' Fahrzeugen';
  $('rows').replaceChildren();
  for (const [key, p] of visibleRows.slice(page * 50, (page + 1) * 50)) {
    const row = el('tr'), model = el('td');
    model.append(el('span', key.split('|')[0], 'make-label'), button(key.split('|')[1], () => openDetail(key), 'model-button'));
    if (p.manualPrice || p.offers?.some((o) => o.manualPrice)) model.append(el('span', 'Preis korrigiert', 'badge'));
    if (p.stale) model.append(el('span', 'Letzter guter Preis', 'badge warn'));
    if (key in draft.mapping) model.append(el('span', 'Quelle korrigiert', 'badge'));
    row.append(model, el('td', amount(p.endpreis), 'amount'));
    for (const tag of D.TAGS.slice(0, 2)) row.append(el('td', amount(p.offers?.find((o) => o.tag === tag)?.endpreis), 'amount'));
    row.append(el('td', p.lieferzeit || '—'));
    const confidence = el('td');confidence.append(el('span', Math.round((p.confidence || 0) * 100) + ' %', 'badge' + (p.confidence < .85 ? ' warn' : '')));row.append(confidence);
    $('rows').append(row);
  }
  if (!visibleRows.length) { const td = el('td', 'Keine Fahrzeuge für diese Filter.');td.colSpan = 6;const row = el('tr');row.append(td);$('rows').append(row); }
  $('prev').disabled = page === 0; $('next').disabled = page >= totalPages - 1;
  $('page-label').textContent = 'Seite ' + (page + 1) + ' von ' + totalPages;
  const changed = [...new Set([...correctedKeys, ...Object.keys(saved.mapping), ...Object.keys(saved.prices)])]
    .filter((k) => JSON.stringify([draft.mapping[k], draft.prices[k]]) !== JSON.stringify([saved.mapping[k], saved.prices[k]]));
  $('draft-count').textContent = changed.length + ' Entwürfe';
  $('save').disabled = !dirty(); $('discard').disabled = !dirty();
  $('correction-list').replaceChildren();
  for (const key of [...new Set([...correctedKeys, ...changed])]) {
    const row = el('div', undefined, 'correction-row'), text = el('div', key.replace('|', ' · '));
    if (key in draft.mapping) text.append(el('span', draft.mapping[key] === null ? 'Ausgeschlossen' : 'Zuordnung', 'badge'));
    if (key in draft.prices) text.append(el('span', 'Preiswerte', 'badge'));
    if (changed.includes(key)) text.append(el('span', 'Entwurf', 'badge draft'));
    row.append(text, button('Korrekturen zurücksetzen', () => { delete draft.mapping[key];delete draft.prices[key];render(); }));
    $('correction-list').append(row);
  }
  if (!correctedKeys.length && !changed.length) $('correction-list').append(el('p', 'Noch keine manuellen Korrekturen.', 'muted'));
}
function sourceText(source) {
  if (!source) return 'Quelle noch nicht aufgezeichnet. Bitte das Fahrzeug neu abrufen.';
  return [source.slug, source.variantName || ('Variante ' + source.variantId),
    ['Motor ' + source.motorId, source.kwh != null ? source.kwh + ' kWh' : '', source.kw != null ? source.kw + ' kW' : ''].filter(Boolean).join(' · '),
    'Tarif ' + (source.tariffId || 'ohne ID') + ' · Abruf ' + date(source.fetchedAt)].join(' → ');
}
function safeLink(url, text) {
  const link = el('a', text);
  const target = new URL(url, 'https://www.apl.de');
  if (target.origin !== 'https://www.apl.de' || !target.pathname.startsWith('/neuwagen/')) throw new Error('Ungültiger APL-Link.');
  link.href = target.href;link.target = '_blank';link.rel = 'noopener'; return link;
}
function sourceSelector(key, slot, current, container) {
  const grid = el('div', undefined, 'source-grid');
  const model = el('select'), variant = el('select'), motor = el('select'), offer = el('select');
  for (const [name, node] of [['APL-Modell', model], ['Ausstattungsvariante', variant], ['Motorisierung', motor], ['Konkretes Angebot', offer]]) {
    const label = el('label', name);label.append(node);grid.append(label);
  }
  const models = Object.entries(data.modelUrls || {}).sort(([a], [b]) => a.localeCompare(b, 'de'));
  model.append(new Option('Modell auswählen', ''), ...models.map(([slug, url]) => new Option(new URL(url).pathname.split('/').slice(2, 4).join(' · '), slug)));
  model.value = current?.slug || effective()[key]?.slug || '';
  function updateOffers() {
    const tag = slot === 'base' ? D.TAGS[0] : slot;
    const offers = cache.lineData[variant.value]?.data.offers?.[motor.value] || [];
    offer.replaceChildren(new Option('Angebot auswählen', ''), ...offers.filter((o) => o.tag === tag && o.tariffId !== undefined)
      .map((o) => new Option(amount(o.endpreis) + ' · Tarif ' + (o.tariffId || 'ohne ID'), o.tariffId)));
    offer.value = current?.variantId === variant.value && current?.motorId === motor.value ? current.tariffId : '';
  }
  function updateMotors() {
    motor.replaceChildren(new Option('Motor auswählen', ''), ...Object.keys(cache.lineData[variant.value]?.data.offers || {}).map((id) => {
      const spec = cache.motorSpecs[id]; return new Option(['Motor ' + id, spec?.kwh != null ? spec.kwh + ' kWh' : '', spec?.kw != null ? spec.kw + ' kW' : ''].filter(Boolean).join(' · '), id);
    }));
    motor.value = current?.variantId === variant.value ? current.motorId : '';updateOffers();
  }
  function updateVariants() {
    variant.replaceChildren(new Option('Variante auswählen', ''), ...(cache.slugLines[model.value]?.lines || []).map((v) => new Option(v.name, v.id)));
    variant.value = current?.slug === model.value ? current.variantId : '';updateMotors();
  }
  model.onchange = updateVariants;variant.onchange = updateMotors;motor.onchange = updateOffers; updateVariants();
  const actions = el('div', undefined, 'actions');
  actions.append(button('Varianten laden / aktualisieren', () => {
    if (!model.value) throw new Error('Bitte zuerst ein APL-Modell wählen.');return dispatch('catalogue', model.value);
  }));
  actions.append(button('Quelle als Entwurf übernehmen', () => {
    if (!model.value || !variant.value || !motor.value || offer.selectedIndex <= 0) throw new Error('Bitte Modell, Variante, Motor und Angebot auswählen.');
    const ref = { slug: model.value, variantId: variant.value, motorId: motor.value, tariffId: offer.value };
    const patch = slot === 'base' ? draft.prices[key]?.base : draft.prices[key]?.offers?.[slot];
    if (patch && D.sourceId(patch.source) !== D.sourceId(ref) && !confirm('Beim Quellenwechsel wird die vorhandene Zahlenkorrektur für dieses Angebot entfernt. Fortfahren?')) return;
    draft.mapping[key] = draft.mapping[key] || {};
    if (slot === 'base') { draft.mapping[key].base = ref;delete draft.mapping[key].slug;if (draft.prices[key] && D.sourceId(current) !== D.sourceId(ref)) delete draft.prices[key].base; }
    else { draft.mapping[key].offers ||= {};draft.mapping[key].offers[slot] = ref;if (draft.prices[key]?.offers && D.sourceId(current) !== D.sourceId(ref)) delete draft.prices[key].offers[slot]; }
    cleanPrices(key);D.validate(draft);render();openDetail(key);notice('Neue Quelle als Entwurf übernommen. Zum Anwenden in GitHub speichern.');
  }, 'secondary'));
  grid.append(actions);container.append(grid);
}
function cleanPrices(key) {
  const p = draft.prices[key];if (!p) return;
  if (p.offers && !Object.keys(p.offers).length) delete p.offers;
  if (!p.base && !p.offers) delete draft.prices[key];
}
function openDetail(key) {
  selectedKey = key;
  $('detail-message').hidden = true;
  const entry = effective()[key];
  let original = D.rawPrices(data)[key];
  try { original = D.applyMappings(D.rawPrices(data), draft, cache)[key]; } catch {}
  if (!entry) throw new Error('Fahrzeug ist ausgeschlossen oder hat noch keinen Preis.');
  $('detail-title').textContent = key.replace('|', ' · ');const content = $('detail-content');content.replaceChildren();
  const actions = el('div', undefined, 'detail-actions');
  actions.append(button('Fahrzeug neu abrufen', () => dispatch('vehicle', key), 'primary'), button('Fahrzeug ausschließen', () => {
    if (!confirm('Fahrzeug dauerhaft ausschließen? Es kann über die Korrekturliste wiederhergestellt werden.')) return;
    draft.mapping[key] = null;delete draft.prices[key];$('detail').close();render();
  }), button('Alle Korrekturen zurücksetzen', () => { delete draft.mapping[key];delete draft.prices[key];render();openDetail(key); }));
  content.append(actions, el('p', 'Quellenänderungen werden nach dem Speichern verarbeitet. Ein Neuabruf erhält manuelle Preiswerte; mit „Preiswerte zurücksetzen“ verwendest du wieder die Abrufwerte.', 'detail-note'));
  for (const slot of ['base', ...D.TAGS]) {
    const value = slot === 'base' ? entry : entry.offers?.find((o) => o.tag === slot);
    const raw = slot === 'base' ? original : original?.offers?.find((o) => o.tag === slot);
    const card = el('section', undefined, 'offer-card');card.append(el('h3', slot === 'base' ? 'Zugeordneter Fahrzeugpreis' : slot));
    card.append(el('p', sourceText(value?.source), 'source-label'));
    if (value?.source?.url) card.append(safeLink(value.source.url, 'APL-Quelle öffnen ↗'));
    const inputs = {}, fields = el('div', undefined, 'value-grid');
    for (const field of D.FIELDS) {
      const names = { endpreis: 'Endpreis €', kaufpreis: 'Kaufpreis €', ersparnis: 'Ersparnis € (%)', lieferzeit: 'Lieferzeit' };
      const label = el('label', names[field]), input = el('input');input.type = 'text';input.value = value?.[field] || '';
      if (['endpreis', 'kaufpreis'].includes(field)) input.inputMode = 'decimal';
      label.append(input, el('span', 'Abrufwert: ' + (raw?.[field] || '—'), 'original'));fields.append(label);inputs[field] = input;
    }
    card.append(fields);const buttons = el('div', undefined, 'actions');
    buttons.append(button('Preiswerte als Entwurf übernehmen', () => {
      if (!value?.source) throw new Error('Bitte zuerst eine Preisquelle auswählen oder neu abrufen.');
      const values = {};
      for (const f of D.FIELDS) if (inputs[f].value.trim() !== (raw?.[f] || '')) values[f] = inputs[f].value.trim();
      const config = D.clone(draft);config.prices[key] ||= {};
      const patch = { source: value.source, values };
      if (slot === 'base') { if (Object.keys(values).length) config.prices[key].base = patch;else delete config.prices[key].base; }
      else { config.prices[key].offers ||= {};if (Object.keys(values).length) config.prices[key].offers[slot] = patch;else delete config.prices[key].offers[slot]; }
      if (!config.prices[key].base && !Object.keys(config.prices[key].offers || {}).length) delete config.prices[key];
      D.validate(config);draft = config;render();openDetail(key);notice('Preiswerte als Entwurf übernommen.');
    }), button('Preiswerte zurücksetzen', () => {
      if (slot === 'base' && draft.prices[key]) delete draft.prices[key].base;
      else if (draft.prices[key]?.offers) delete draft.prices[key].offers[slot];
      cleanPrices(key);render();openDetail(key);
    }));
    if (value?.source) buttons.append(button('Dieses Angebot neu abrufen', () => dispatch('offer', JSON.stringify({ ...value.source, tag: slot === 'base' ? D.TAGS[0] : slot }))));
    buttons.append(button('Zuordnung zurücksetzen', () => {
      const m = draft.mapping[key];if (!m) return;
      if (slot === 'base') { delete m.base;delete m.slug; } else if (m.offers) delete m.offers[slot];
      if (!m.base && !m.slug && !Object.keys(m.offers || {}).length) delete draft.mapping[key];
      render();openDetail(key);
    }));
    card.append(buttons);sourceSelector(key, slot, value?.source, card);content.append(card);
  }
  if (!$('detail').open) $('detail').showModal();
}
async function save() {
  if (!token) { $('auth').showModal();notice('Bitte GitHub verbinden, danach erneut speichern.');return; }
  D.validate(draft);$('save').disabled = true;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(draft, null, 2) + '\n');
    const result = await api('/contents/tools/dashboard-overrides.json', { method: 'PUT', body: JSON.stringify({
      branch: 'main', sha: fileSha, message: 'dashboard: update price corrections and assignments',
      content: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    }) });
    saved = D.clone(draft);fileSha = result.content.sha;render();
    requests.unshift({ commit: result.commit.sha, label: 'Korrekturen übernehmen', status: 'angefordert', url: result.commit.html_url });
    notice('Korrekturen in GitHub gespeichert. Die Preisdatei wird automatisch aktualisiert.');renderRuns();pollRuns();
  } finally { $('save').disabled = !dirty(); }
}
async function dispatch(mode, target) {
  if (!token) { $('auth').showModal();notice('Zum Starten eines Abrufs bitte GitHub verbinden.');return; }
  if (dirty()) throw new Error('Bitte zuerst die Entwürfe speichern oder verwerfen. Neuabrufe verwenden die gespeicherten Zuordnungen.');
  const ids = mode === 'offer' ? [JSON.parse(target).variantId] : mode === 'catalogue' ? (cache.slugLines[target]?.lines || []).map((v) => v.id) :
    [...new Set([...(cache.slugLines[data.prices[target]?.slug]?.lines || []).map((v) => v.id), ...D.references(data.prices[target]).map((s) => s.variantId)])];
  const affected = D.affected(data.prices, ids);
  if (!confirm('APL-Quelle neu abrufen? ' + affected.length + ' damit verknüpfte Fahrzeuge können aktualisiert werden. Der übrige Bestand und manuelle Preiswerte bleiben erhalten.')) return;
  const requestId = crypto.randomUUID();
  const result = await api('/actions/workflows/apl-prices.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { mode, target, request_id: requestId } }) });
  requests.unshift({ id: result?.workflow_run_id, requestId, label: mode === 'vehicle' ? target.replace('|', ' · ') : mode === 'catalogue' ? 'Varianten: ' + target : 'Einzelangebot neu abrufen',
    status: 'angefordert', url: result?.html_url });renderRuns();notice('Neuabruf angefordert. Der Status erscheint unter „Abrufe“.');pollRuns();
}
function renderRuns() {
  $('run-list').replaceChildren();
  for (const request of requests) {
    const row = el('div', undefined, 'run-row'), text = el('div', request.label);
    text.append(el('small', request.status));row.append(text);
    if (request.url) { const link = el('a', 'GitHub-Lauf ↗');link.href = request.url;link.target = '_blank';link.rel = 'noopener';row.append(link); }
    $('run-list').append(row);
  }
}
async function pollRuns() {
  if (polling || !token || !requests.some((r) => !r.done)) return;
  polling = true;
  try {
    const response = await api('/actions/workflows/apl-prices.yml/runs?per_page=30');
    let completed = false;
    for (const request of requests.filter((r) => !r.done)) {
      const run = response.workflow_runs.find((r) => request.id ? r.id === request.id : request.commit ? r.head_sha === request.commit && r.event === 'push' : r.display_title.includes(request.requestId));
      if (!run) continue;
      request.id = run.id;request.url = run.html_url;
      const names = { queued: 'In Warteschlange', in_progress: 'Abruf läuft', waiting: 'Wartet auf Freigabe', completed: run.conclusion === 'success' ? 'Erfolgreich abgeschlossen' : 'Fehlgeschlagen: ' + run.conclusion };
      request.status = names[run.status] || run.status;
      if (run.status === 'completed') { request.done = true;completed ||= run.conclusion === 'success'; }
    }
    renderRuns();if (completed && !dirty() && !$('detail').open) await load();
    else if (completed) notice('Abruf abgeschlossen. Schließe die Details und lade den aktuellen Stand; Entwürfe vorher speichern.');
  } catch (error) { showError(error); }
  finally { polling = false;if (token && requests.some((r) => !r.done)) setTimeout(pollRuns, 20000); }
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = el('a');link.href = url;link.download = name;link.click();setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('auth-form').onsubmit = async (event) => {
  event.preventDefault();token = $('token').value.trim();$('token').value = '';
  try { const repo = await api('');if (!repo.permissions?.push) throw new Error('Dieser GitHub-Account hat keinen Schreibzugriff auf das Repo.');
    $('auth').close();$('connect').textContent = 'Verbunden · Abmelden';notice('GitHub verbunden. Das Token wird beim Neuladen gelöscht.');pollRuns();
  } catch (error) { token = '';showError(error); }
};
$('connect').onclick = () => { if (token) { token = '';$('connect').textContent = 'GitHub verbinden';notice('Abgemeldet.'); } else $('auth').showModal(); };
for (const node of document.querySelectorAll('[data-close]')) node.onclick = () => $(node.dataset.close).close();
$('save').onclick = () => save().catch(showError);
$('discard').onclick = () => { if (confirm('Alle ungespeicherten Entwürfe verwerfen?')) { draft = D.clone(saved);render(); } };
$('reload').onclick = () => load().catch(showError);
$('filters').onsubmit = (event) => event.preventDefault();
$('filters').oninput = () => { page = 0;render(); };
$('reset-filters').onclick = () => { $('filters').reset();page = 0;render(); };
for (const node of document.querySelectorAll('[data-sort]')) node.onclick = () => {
  direction = sort === node.dataset.sort ? -direction : 1;sort = node.dataset.sort;page = 0;
  for (const th of document.querySelectorAll('th[aria-sort]')) th.setAttribute('aria-sort', 'none');
  node.closest('th').setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');render();
};
$('prev').onclick = () => { page--;render(); };$('next').onclick = () => { page++;render(); };
$('csv').onclick = () => {
  const quote = (v) => '"' + String(v ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
  const rows = [['Fahrzeug', 'Fahrzeugpreis', ...D.TAGS, 'Lieferzeit', 'Zuordnung'], ...visibleRows.map(([key, p]) => [key.replace('|', ' · '), p.endpreis, ...D.TAGS.map((tag) => p.offers?.find((o) => o.tag === tag)?.endpreis), p.lieferzeit, p.confidence])];
  download('apl-preise.csv', '\uFEFF' + rows.map((r) => r.map(quote).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
};
$('json').onclick = () => download('apl-dashboard.json', JSON.stringify({ ...data, prices: effective(), dashboardDraft: draft }, null, 2), 'application/json');
window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault();event.returnValue = ''; } });
load().catch(showError);
