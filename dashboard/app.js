'use strict';
const E = EVDB, D = APLDashboard, $ = (id) => document.getElementById(id);
const REPO = 'gnagster/evdb-apl-sync', API = 'https://api.github.com/repos/' + REPO;
const TOKEN_KEY = 'apl-dashboard:' + REPO + ':token';
let token = '', data, database, cache, filterControls = { groups: {}, ranges: {} }, saved = D.empty(), draft = D.empty(), fileSha = '', page = 0;
let authGeneration = 0;
let sort = 'rank', direction = -1, selectedKey = '', visibleRows = [], requests = [], sourceViews = [], polling = false;
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
  for (const node of [$('message'), ...(!$('auth').hidden ? [$('auth-message')] : []), ...document.querySelectorAll('dialog[open] .notice')]) {
    node.hidden = false;node.textContent = message;node.classList.toggle('error', error);
  }
}
function showError(error) { notice(error.message || String(error), true); }
async function api(path, options = {}) {
  if (!token) throw new Error('Bitte zuerst das Dashboard mit einem gültigen Token entsperren.');
  const requestToken = token;
  const response = await fetch(API + path, { ...options, headers: {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {})
  }, cache: 'no-store' });
  if (requestToken !== token) throw new Error('Die Sitzung wurde beendet.');
  if (!response.ok) {
    const messages = { 401: 'Das Token ist ungültig oder abgelaufen.', 403: 'GitHub verweigert den Zugriff. Prüfe die Token-Rechte und das API-Limit.',
      409: 'Die Datei wurde zwischenzeitlich geändert. Deine Entwürfe bleiben erhalten. Exportiere sie oder lade den aktuellen Stand.',
      422: 'GitHub konnte die Anfrage nicht übernehmen. Bitte den aktuellen Stand laden und erneut versuchen.' };
    const message = messages[response.status] || 'GitHub-Anfrage fehlgeschlagen (' + response.status + ').';
    if (response.status === 401) lock(true, message);
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}
async function load() {
  if (!token) throw new Error('Bitte zuerst das Dashboard entsperren.');
  const requestToken = token;
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
    const [prices, scrapeCache, configFile, vehicles] = await Promise.all([
      read('apl-prices.json'), read('tools/scrape-cache.json'), api('/contents/tools/dashboard-overrides.json?ref=' + commit.sha), read('evdb-vehicles.json')
    ]);
    if (requestToken !== token) return;
    if (!prices.prices || typeof prices.count !== 'number') throw new Error('Ungültige Preisdatei.');
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(configFile.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
    const migration = E.migrate(D.validate(JSON.parse(decoded)), vehicles.vehicles);
    saved = migration.config;draft = D.clone(saved);fileSha = configFile.sha;
    if (migration.conflicts.length) notice('Zuordnungskonflikte (bitte getrennt nach EVDB-ID korrigieren): ' + migration.conflicts.join(', '), true);
    data = prices;database = vehicles;cache = scrapeCache;buildFilters();
    page = 0; render();
    if (!data.modelUrls) notice('Die Quellenübersicht wird beim nächsten vollständigen Abruf ergänzt.');
    else if (JSON.stringify(saved) !== JSON.stringify(data.appliedOverrides)) notice('Korrekturen sind gespeichert. Die Übernahme in die Preisdatei läuft noch.');
    else if (data.migrationConflicts?.length) notice('Zuordnungskonflikte: ' + data.migrationConflicts.join(', '), true);
    else if (data.warnings?.length) notice(data.warnings.join('\n'), true);
    else if (!migration.conflicts.length) $('message').hidden = true;
  } finally { $('reload').disabled = false; }
}
function effective() {
  let prices = E.idPrices(data, database.vehicles, true);
  try { prices = D.applyMappings(prices, draft, cache); }
  catch { /* Saved assignment may be waiting for its targeted source fetch. */ }
  return D.applyPrices(prices, draft).prices;
}
function buildFilters() {
  filterControls = { groups: {}, ranges: {} };$('evdb-filters').replaceChildren();
  $('sort').replaceChildren(...E.sorts.map(([value,label]) => new Option(label, value)));$('sort').value = sort;
  for (const [name, group] of Object.entries(database.filters.groups)) {
    const details = el('details'), summary = el('summary', group.label), options = el('div', undefined, 'filter-checks');
    details.append(summary, options);filterControls.groups[name] = [];
    for (const option of group.options) {
      const input = el('input');input.type = 'checkbox';input.value = option.value;
      input.defaultChecked = input.checked = name === 'availability' && option.value === 'current';
      const label = el('label');label.append(input, el('span', option.label));options.append(label);filterControls.groups[name].push(input);
    }
    $('evdb-filters').append(details);
  }
  for (const def of database.filters.ranges) {
    const details = el('details'), summary = el('summary', def.label + ' · ' + def.unit + (def.openMax ? ' · oberes Ende offen' : ''));
    const controls = {}, grid = el('div', undefined, 'range-controls');
    for (const side of ['min','max']) {
      const label = el('label', side === 'min' ? 'Von' : 'Bis'), number = el('input'), slider = el('input');
      for (const input of [number,slider]) { input.type = input === number ? 'number' : 'range';input.min = def.min;input.max = def.max;input.step = def.step;input.value = input.defaultValue = def[side];input.setAttribute('aria-label', def.label + ' ' + (side === 'min' ? 'von' : 'bis')); }
      number.oninput = () => { slider.value = number.value; };slider.oninput = () => { number.value = slider.value; };
      label.append(number, slider);grid.append(label);controls[side] = number;
    }
    const unknown = el('input');unknown.type = 'checkbox';controls.unknown = unknown;
    const label = el('label', undefined, 'unknown-option');label.append(unknown, el('span', def.field === 'safetyStars' ? 'Nicht getestet einschließen' : def.field === 'cargoL' ? 'Unbekanntes Ladevolumen einschließen' : 'Unbekannte Angaben einschließen'));
    const only = el('input');only.type = 'checkbox';controls.only = only;
    const onlyLabel = el('label', undefined, 'unknown-option');onlyLabel.append(only, el('span', def.field === 'safetyStars' ? 'Nur nicht getestete Fahrzeuge' : 'Nur unbekannte Angaben'));
    details.append(summary, grid, label, onlyLabel);filterControls.ranges[def.field] = controls;$('evdb-filters').append(details);
  }
}
function filters() {
  const groups = Object.fromEntries(Object.entries(filterControls.groups).map(([key,nodes]) => [key,nodes.filter((n) => n.checked).map((n) => n.value)]));
  const ranges = Object.fromEntries(Object.entries(filterControls.ranges).map(([key,nodes]) => [key,{ min: Number(nodes.min.value), max: Number(nodes.max.value), unknown: nodes.unknown.checked, unknownOnly: nodes.only.checked }]));
  return { query: $('query').value, tag: $('tag').value, groups, ranges,
    uncertain: $('uncertain').checked, corrected: $('corrected').checked, sort, direction };
}
function labelFor(key) { const v = database?.vehicles.find((v) => E.key(v) === key);return v ? v.title + ' · EVDB ' + v.id : key.replace('|', ' · ') + ' · Zuordnungskonflikt'; }
function render() {
  if (!data) return;
  const prices = effective();
  visibleRows = E.rows(database, prices, draft, filters(), D.money);
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / 50)); page = Math.min(page, totalPages - 1);
  $('updated').textContent = 'EVDB: ' + date(database.fetchedAt) + ' · APL: ' + date(data.generatedAt);
  $('vehicle-count').textContent = database.vehicles.length;
  $('offer-count').textContent = Object.values(prices).reduce((n, p) => n + (p.offers || []).length, 0);
  $('uncertain-count').textContent = Object.values(prices).filter((p) => p.confidence < .85).length;
  const correctedKeys = [...new Set([...Object.keys(draft.mapping), ...Object.keys(draft.prices)])];
  $('correction-count').textContent = correctedKeys.length;
  $('result-count').textContent = visibleRows.length + ' von ' + database.vehicles.length + ' Fahrzeugen';
  $('rows').replaceChildren();
  for (const [key, p] of visibleRows.slice(page * 50, (page + 1) * 50)) {
    const row = el('tr'), model = el('td');
    model.append(el('span', p.make, 'make-label'), button(p.model, () => openDetail(key), 'model-button'));
    if (p.manualPrice || p.offers?.some((o) => o.manualPrice)) model.append(el('span', 'Preis korrigiert', 'badge'));
    if (p.stale) model.append(el('span', 'Letzter guter Preis', 'badge warn'));
    if (key in draft.mapping) model.append(el('span', draft.mapping[key]?.evdbOnly ? 'Nicht bei APL gelistet' : 'Quelle korrigiert', 'badge'));
    model.append(el('span', E.labels[p.status], 'badge'));
    const price = el('td', p.priceEur === null ? '—' : eur.format(p.priceEur), 'amount');price.append(el('small', p.priceSource, 'make-label'));
    row.append(model, price);
    for (const tag of D.TAGS.slice(0, 2)) row.append(el('td', amount(p.offers?.find((o) => o.tag === tag)?.endpreis), 'amount'));
    row.append(el('td', p.lieferzeit || '—'));
    for (const [field,unit] of [['rangeKm','km'],['batteryKwh','kWh'],['efficiencyWhKm','Wh/km']]) row.append(el('td', p[field] == null ? '—' : p[field] + ' ' + unit));
    const confidence = el('td');confidence.append(el('span', p.confidence == null ? '—' : Math.round(p.confidence * 100) + ' %', 'badge' + (p.confidence < .85 ? ' warn' : '')));row.append(confidence);
    $('rows').append(row);
  }
  if (!visibleRows.length) { const td = el('td', 'Keine Fahrzeuge für diese Filter.');td.colSpan = 9;const row = el('tr');row.append(td);$('rows').append(row); }
  $('prev').disabled = page === 0; $('next').disabled = page >= totalPages - 1;
  $('page-label').textContent = 'Seite ' + (page + 1) + ' von ' + totalPages;
  const changed = [...new Set([...correctedKeys, ...Object.keys(saved.mapping), ...Object.keys(saved.prices)])]
    .filter((k) => JSON.stringify([draft.mapping[k], draft.prices[k]]) !== JSON.stringify([saved.mapping[k], saved.prices[k]]));
  $('draft-count').textContent = changed.length + ' Entwürfe';
  $('save').disabled = !dirty(); $('discard').disabled = !dirty();
  $('correction-list').replaceChildren();
  for (const key of [...new Set([...correctedKeys, ...changed])]) {
    const row = el('div', undefined, 'correction-row'), text = el('div', labelFor(key));
    if (key in draft.mapping) text.append(el('span', draft.mapping[key] === null ? 'Ausgeschlossen' : draft.mapping[key].evdbOnly ? 'Nicht bei APL gelistet · EVDB-Listenpreis' : 'Zuordnung', 'badge'));
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
  const status = el('div', undefined, 'catalogue-status');status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');
  const loadButton = button('Varianten laden / aktualisieren', async () => {
    if (!model.value) throw new Error('Bitte zuerst ein APL-Modell wählen.');
    const previous = requests.find((r) => r.mode === 'catalogue' && r.target === model.value);
    if (previous?.needsResults) {
      loadButton.disabled = true;
      try { await refreshCatalogue(previous); }
      catch (e) { previous.status = 'Ergebnisse konnten nicht geladen werden: ' + e.message; }
      finally { renderRuns();updateSourceViews(); }
      return;
    }
    return dispatch('catalogue', model.value);
  });
  sourceViews.push({ model, status, loadButton, grid, refresh: () => {
    const selection = { variant: variant.value, motor: motor.value, offer: offer.value };
    updateVariants();
    if ([...variant.options].some((o) => o.value === selection.variant)) variant.value = selection.variant;
    updateMotors();
    if ([...motor.options].some((o) => o.value === selection.motor)) motor.value = selection.motor;
    updateOffers();
    if ([...offer.options].some((o) => o.value === selection.offer)) offer.value = selection.offer;
  } });
  model.onchange = () => { updateVariants();updateSourceViews(); };
  actions.append(loadButton);
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
  grid.append(actions, status);container.append(grid);updateSourceViews();
}
function cleanPrices(key) {
  const p = draft.prices[key];if (!p) return;
  if (p.offers && !Object.keys(p.offers).length) delete p.offers;
  if (!p.base && !p.offers) delete draft.prices[key];
}
function openDetail(key) {
  sourceViews = [];
  selectedKey = key;
  $('detail-message').hidden = true;
  const vehicle = database.vehicles.find((v) => E.key(v) === key);
  const entry = effective()[key] || (vehicle && draft.mapping[key] !== null ? { offers: [] } : null);
  let original = E.idPrices(data, database.vehicles, true)[key];
  try { original = D.applyMappings(E.idPrices(data, database.vehicles, true), draft, cache)[key]; } catch {}
  if (!entry) throw new Error('Fahrzeug ist ausgeschlossen oder hat noch keinen Preis.');
  $('detail-title').textContent = labelFor(key);const content = $('detail-content');content.replaceChildren();
  const actions = el('div', undefined, 'detail-actions');
  actions.append(button('Fahrzeug neu abrufen', () => dispatch('vehicle', key), 'primary'), button('Fahrzeug ausschließen', () => {
    if (!confirm('Fahrzeug dauerhaft ausschließen? Es kann über die Korrekturliste wiederhergestellt werden.')) return;
    draft.mapping[key] = null;delete draft.prices[key];$('detail').close();render();
  }), button('Alle Korrekturen zurücksetzen', () => { delete draft.mapping[key];delete draft.prices[key];render();openDetail(key); }));
  if (vehicle) {
    const specs = el('dl', undefined, 'spec-list');
    const link = el('a', 'EVDB-Fahrzeug öffnen ↗');const sourceUrl = new URL(vehicle.url);if (sourceUrl.origin !== 'https://ev-database.org' || !/^\/car\/\d+\//.test(sourceUrl.pathname)) throw Error('Ungültiger EVDB-Link.');link.href = sourceUrl.href;link.target = '_blank';link.rel = 'noopener';content.append(link);
    for (const [field,value] of Object.entries(vehicle)) { const definition = Object.values(E.fields).find((d) => d[0] === field);specs.append(el('dt', definition?.[1] || ({id:'EVDB-ID',make:'Hersteller',model:'Modell',title:'Fahrzeug',status:'Status',tokens:'Merkmale',shape:'Karosserie',rank:'Beliebtheit',url:'Quelle',availableFrom:'Verfügbar ab',availableTo:'Verfügbar bis',yearFrom:'Von Jahr',yearTo:'Bis Jahr'})[field] || field), el('dd', value == null ? 'Unbekannt / offen' : field === 'status' ? E.labels[value] : field.startsWith('available') ? new Date(value * 1000).toLocaleDateString('de-DE') : Array.isArray(value) ? value.map((v) => E.labels[v] || v).join(', ') : value + (definition ? ' ' + definition[2] : ''))); }
    content.append(specs);
    if (!entry.source) content.append(el('p', 'EVDB-Listenpreis: ' + (vehicle.priceEur == null ? 'nicht verfügbar' : eur.format(vehicle.priceEur)) + '. Für eigene Preiswerte zuerst eine APL-Quelle auswählen.', 'detail-note'));
  }
  const evdbOnly = el('input');evdbOnly.type = 'checkbox';evdbOnly.checked = !!draft.mapping[key]?.evdbOnly;
  const evdbLabel = el('label', undefined, 'unknown-option');evdbLabel.append(evdbOnly, el('span', 'Nicht bei APL gelistet – EVDB-Listenpreis verwenden'));
  evdbOnly.onchange = () => {
    if (evdbOnly.checked) {
      if (draft.prices[key] && !confirm('Mit dem Wechsel zum EVDB-Listenpreis werden die APL-Zuordnung und die vorhandenen Zahlenkorrekturen entfernt. Fortfahren?')) { evdbOnly.checked = false;return; }
      draft.mapping[key] = { evdbOnly: true };delete draft.prices[key];
    } else delete draft.mapping[key];
    render();openDetail(key);notice('Preisquelle als Entwurf geändert. Mit „In GitHub speichern“ dauerhaft übernehmen.');
  };
  content.append(evdbLabel, actions, el('p', 'Quellenänderungen werden nach dem Speichern verarbeitet. Ein Neuabruf erhält manuelle Preiswerte; mit „Preiswerte zurücksetzen“ verwendest du wieder die Abrufwerte.', 'detail-note'));
  if (draft.mapping[key]?.evdbOnly) {
    actions.firstChild.disabled = true;
    content.append(el('p', 'Für dieses Fahrzeug wird ausschließlich der EVDB-Listenpreis verwendet. Zum erneuten Zuordnen einer APL-Quelle die Markierung entfernen.', 'detail-note'));
    if (!$('detail').open) $('detail').showModal();return;
  }
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
  if (!token) { lock(false, 'Bitte das Dashboard entsperren, danach erneut speichern.');return; }
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
  if (!token) { lock(false, 'Zum Starten eines Abrufs bitte das Dashboard entsperren.');return; }
  if (mode !== 'catalogue' && dirty()) throw new Error('Bitte zuerst die Entwürfe speichern oder verwerfen. Neuabrufe verwenden die gespeicherten Zuordnungen.');
  const ids = mode === 'offer' ? [JSON.parse(target).variantId] : mode === 'catalogue' ? (cache.slugLines[target]?.lines || []).map((v) => v.id) :
    [...new Set([...(cache.slugLines[effective()[target]?.slug]?.lines || []).map((v) => v.id), ...D.references(effective()[target]).map((s) => s.variantId)])];
  const affected = D.affected(effective(), ids);
  if (mode !== 'catalogue' && !confirm('APL-Quelle neu abrufen? ' + affected.length + ' damit verknüpfte Fahrzeuge können aktualisiert werden. Der übrige Bestand und manuelle Preiswerte bleiben erhalten.')) return;
  const existing = requests.find((r) => r.mode === 'catalogue' && r.target === target && !r.done);
  if (mode === 'catalogue' && existing) return existing;
  const requestId = crypto.randomUUID();
  const request = { mode, target, requestId, label: mode === 'vehicle' ? labelFor(target) : mode === 'catalogue' ? 'Varianten: ' + target : 'Einzelangebot neu abrufen', status: 'Abruf wird angefordert', done: false };
  requests.unshift(request);renderRuns();updateSourceViews();
  try {
    const result = await api('/actions/workflows/apl-prices.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { mode, target, request_id: requestId } }) });
    Object.assign(request, { id: result?.workflow_run_id, url: result?.html_url, status: 'Angefordert – wartet auf GitHub Actions' });
    renderRuns();updateSourceViews();
    if (mode !== 'catalogue') notice('Neuabruf angefordert. Der Status erscheint unter „Abrufe“.');
    pollRuns();return request;
  } catch (e) {
    request.done = true;request.status = 'Abruf konnte nicht gestartet werden: ' + e.message;
    renderRuns();updateSourceViews();throw e;
  }
}
function updateSourceViews() {
  for (const view of sourceViews) {
    const request = requests.find((r) => r.mode === 'catalogue' && r.target === view.model.value);
    view.loadButton.disabled = !!request && !request.done;
    view.loadButton.textContent = request?.needsResults ? 'Ergebnisse erneut laden' : request && !request.done ? 'Varianten werden geladen …' : 'Varianten laden / aktualisieren';
    view.loadButton.setAttribute('aria-busy', request && !request.done ? 'true' : 'false');view.grid.classList.toggle('is-loading', !!request && !request.done);
    const ids = (cache.slugLines[view.model.value]?.lines || []).map((v) => v.id);
    view.status.replaceChildren(el('span', request?.status || 'Aktualisiert die Varianten und Angebote; ' + D.affected(effective(), ids).length + ' verknüpfte Fahrzeuge werden mit aktualisiert.'));
    if (request?.url) { const link = el('a', 'GitHub-Lauf ↗');link.href = request.url;link.target = '_blank';link.rel = 'noopener';view.status.append(link); }
  }
}
async function refreshCatalogue(request) {
  const generation = authGeneration;
  const commit = await api('/commits/main');
  const response = await fetch('https://raw.githubusercontent.com/' + REPO + '/' + commit.sha + '/tools/scrape-cache.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Quelldaten konnten nicht geladen werden (' + response.status + ').');
  const fresh = await response.json(), lines = fresh.slugLines?.[request.target]?.lines;
  if (generation !== authGeneration || !token) throw new Error('Die Sitzung wurde beendet.');
  if (!Array.isArray(lines) || !lines.length || lines.some((v) => !fresh.lineData?.[v.id]?.data?.offers) || !fresh.motorSpecs) throw new Error('Unvollständige Variantenliste; bisherige Auswahl bleibt erhalten.');
  cache = { ...cache, slugLines: { ...cache.slugLines, [request.target]: fresh.slugLines[request.target] },
    lineData: { ...cache.lineData, ...Object.fromEntries(lines.map((v) => [v.id, fresh.lineData[v.id]])) }, motorSpecs: { ...cache.motorSpecs, ...fresh.motorSpecs } };
  const offerCount = lines.reduce((n, v) => n + Object.values(fresh.lineData[v.id].data.offers).flat().length, 0);
  request.needsResults = false;request.status = lines.length + (offerCount ? ' Varianten geladen – Auswahl kann fortgesetzt werden.' : ' Varianten geladen. APL liefert derzeit keine zuordenbaren Kundenangebote für dieses Modell.');
  for (const view of sourceViews) if (view.model.value === request.target) view.refresh();
  render();
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
      if (run.status === 'completed') {
        request.done = true;
        if (run.conclusion === 'success' && request.mode === 'catalogue') {
          try { await refreshCatalogue(request); }
          catch (e) { request.needsResults = true;request.status = 'Ergebnisse konnten nicht geladen werden: ' + e.message; }
        } else completed ||= run.conclusion === 'success';
      }
    }
    renderRuns();updateSourceViews();if (completed && !dirty() && !$('detail').open) await load();
    else if (completed) notice('Abruf abgeschlossen. Schließe die Details und lade den aktuellen Stand; Entwürfe vorher speichern.');
  } catch (error) {
    for (const r of requests.filter((r) => !r.done && r.mode === 'catalogue')) r.status = 'Statusabfrage fehlgeschlagen – wird erneut versucht: ' + error.message;
    updateSourceViews();showError(error);
  }
  finally { polling = false;if (token && requests.some((r) => !r.done)) setTimeout(pollRuns, 5000); }
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = el('a');link.href = url;link.download = name;link.click();setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// shortcut: This gates the Pages UI; private data requires server authentication.
function lock(removeStored = false, message = '') {
  token = '';authGeneration++;sourceViews = [];
  $('dashboard').hidden = true;$('auth').hidden = false;$('detail').close();
  $('token').value = '';$('auth-submit').disabled = false;
  if (removeStored) {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }
  if (message) notice(message, true);
  $('token').focus();
}
async function authenticate(value) {
  const attempt = ++authGeneration;
  token = value.trim();$('token').value = '';$('auth-submit').disabled = true;
  notice('Token wird geprüft …');
  try {
    const repo = await api('');
    if (attempt !== authGeneration) return;
    if (!repo.permissions?.push) {
      lock(true, 'Dieses Token hat keinen Schreibzugriff auf das Repository.');return;
    }
    try { localStorage.setItem(TOKEN_KEY, token); }
    catch { throw new Error('Das Token kann in diesem Browser nicht gespeichert werden. Bitte die Website-Speicherung erlauben.'); }
    await load();
    if (attempt !== authGeneration) return;
    $('auth').hidden = true;$('dashboard').hidden = false;$('connect').textContent = 'Abmelden';
    $('connect').focus();pollRuns();
  } catch (error) {
    if (attempt !== authGeneration) return;
    lock(false, error.message || String(error));
  } finally { if (attempt === authGeneration) $('auth-submit').disabled = false; }
}
$('auth-form').onsubmit = (event) => { event.preventDefault();authenticate($('token').value); };
$('connect').onclick = () => {
  if (dirty() && !confirm('Ungespeicherte Entwürfe verwerfen und abmelden?')) return;
  saved = D.empty();draft = D.empty();data = undefined;cache = undefined;visibleRows = [];requests = [];
  $('rows').replaceChildren();$('detail-content').replaceChildren();$('correction-list').replaceChildren();$('run-list').replaceChildren();
  lock(true, 'Abgemeldet. Das gespeicherte Token wurde entfernt.');
};
for (const node of document.querySelectorAll('[data-close]')) node.onclick = () => $(node.dataset.close).close();
$('save').onclick = () => save().catch(showError);
$('discard').onclick = () => { if (confirm('Alle ungespeicherten Entwürfe verwerfen?')) { draft = D.clone(saved);render(); } };
$('reload').onclick = () => load().catch(showError);
$('filters').onsubmit = (event) => event.preventDefault();
$('filters').oninput = () => { page = 0;render(); };
$('reset-filters').onclick = () => { $('filters').reset();sort = 'rank';direction = -1;$('sort').value = sort;page = 0;render(); };
$('sort').onchange = () => { sort = $('sort').value;direction = E.sorts.find((s) => s[0] === sort)[3];page = 0;render(); };
for (const node of document.querySelectorAll('[data-sort]')) node.onclick = () => {
  direction = sort === node.dataset.sort || (sort === 'price-desc' && node.dataset.sort === 'price') ? -direction : 1;sort = node.dataset.sort;page = 0;
  for (const th of document.querySelectorAll('th[aria-sort]')) th.setAttribute('aria-sort', 'none');
  if (sort === 'price' && direction === -1) sort = 'price-desc';
  $('sort').value = sort;node.closest('th').setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');render();
};
$('prev').onclick = () => { page--;render(); };$('next').onclick = () => { page++;render(); };
$('csv').onclick = () => {
  const quote = (v) => '"' + String(v ?? '').replace(/^[=+@-]/, "'$&").replace(/"/g, '""') + '"';
  const fields = ['id','make','model','status','priceSource','priceEur','pricePerKm','rangeKm','batteryKwh','efficiencyWhKm','fastchargeKw','accelerationS','stopRangeKm','towingKg','weightKg','cargoL','safetyStars','yearFrom','yearTo','url'];
  const rows = [fields, ...visibleRows.map(([,p]) => fields.map((f) => p[f]))];
  download('apl-preise.csv', '\uFEFF' + rows.map((r) => r.map(quote).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
};
$('json').onclick = () => download('apl-dashboard.json', JSON.stringify({ evdbFetchedAt: database.fetchedAt, aplFetchedAt: data.generatedAt, dashboardDraft: draft, vehicles: visibleRows.map(([,row]) => row) }, null, 2), 'application/json');
window.addEventListener('beforeunload', (event) => { if (dirty()) { event.preventDefault();event.returnValue = ''; } });
let storedToken = '';
try { storedToken = localStorage.getItem(TOKEN_KEY) || ''; }
catch { notice('Die Website-Speicherung ist gesperrt. Bitte im Browser erlauben.', true); }
if (storedToken) authenticate(storedToken);
else $('token').focus();
storedToken = '';
