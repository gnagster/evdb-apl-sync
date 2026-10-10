'use strict';
(function (global) {
  const fields = {
    pricefilter: ['priceEur', 'Preis', '€'], erange_real: ['rangeKm', 'Reichweite', 'km'],
    long_distance_total_sort: ['stopRangeKm', 'Reichweite mit Ladestopp', 'km'], acceleration: ['accelerationS', 'Beschleunigung 0–100', 's'],
    fastcharge_speed: ['fastchargeKw', 'Schnellladen (10–80 %)', 'kW'], battery: ['batteryKwh', 'Nutzbare Batterie', 'kWh'],
    towweight: ['towingKg', 'Anhängelast', 'kg'], efficiency: ['efficiencyWhKm', 'Verbrauch', 'Wh/km'],
    safety: ['safetyStars', 'Sicherheit', 'Sterne'], weight: ['weightKg', 'Gewicht', 'kg'], cargosort: ['cargoL', 'Ladevolumen', 'l'],
    year_from: ['years', 'Verfügbarkeitsjahre', 'Jahr']
  };
  const labels = {
    segment: 'Fahrzeugsegment', bodyshape: 'Karosserie', availability: 'Verfügbarkeit', charging: 'AC-Lader', seats: 'Sitzplätze', drive: 'Antrieb', battchem: 'Batteriechemie', make: 'Hersteller', features: 'Ausstattung und bidirektionales Laden',
    'shape-hatchback':'Schrägheck','shape-sedan':'Limousine','shape-liftback':'Liftback','shape-suv':'SUV','shape-station':'Kombi','shape-cabrio':'Cabrio','shape-coupe':'Coupé','shape-spv':'SPV','shape-mpv':'MPV','shape-pickup':'Pickup',
    current:'Bestellbar',upcoming:'Angekündigt',archive:'Frühere Modelle',voor:'Frontantrieb',achter:'Heckantrieb',awd:'Allradantrieb',
    battchem_lfp:'LFP',battchem_nca:'NCA',battchem_ncm:'NMC',battchem_lfpncm:'LFP/NMC',
    obc_3kw:'3 kW',obc_7kw:'7 kW',obc_11kw:'11 kW',obc_16kw:'16,5 kW',obc_22kw:'22 kW',
    'tow-hitch':'Anhängerkupplung',roofrack:'Dachträger',pnc:'Plug & Charge','battery-precon':'Batterie-Vorkonditionierung',heatpump:'Wärmepumpe',v2xl:'Vehicle-to-Load',v2xh:'Vehicle-to-Home',v2xg:'Vehicle-to-Grid'
  };
  const sorts = [
    ['rank','Meistgesehen','rank',-1],['recent','Zuletzt hinzugefügt','id',-1],['model','Alphabetisch','title',1],
    ['price','Preis aufsteigend','priceEur',1],['price-desc','Preis absteigend','priceEur',-1],['range','Reichweite','rangeKm',-1],
    ['battery','Batterie','batteryKwh',-1],['efficiency','Verbrauch','efficiencyWhKm',1],['value','Preis/km Reichweite','pricePerKm',1],
    ['safety','Sicherheit','safetyStars',-1],['fastcharge','Schnellladen','fastchargeKw',-1],['acceleration','Beschleunigung','accelerationS',1],
    ['towing','Anhängelast','towingKg',-1],['oldest','Verfügbarkeitsbeginn aufsteigend','availableFrom',1],['newest','Verfügbarkeitsbeginn absteigend','availableFrom',-1],
    ['weight','Gewicht','weightKg',1],['cargo','Ladevolumen','cargoL',-1],['stoprange','Reichweite mit Ladestopp','stopRangeKm',-1],['confidence','Zuordnungssicherheit','confidence',-1]
  ];
  const text = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|quot|apos|lt|gt|nbsp);/g, (x) => ({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '})[x]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim();
  const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const number = (s) => { const t = text(s).replace(/[€,]/g, '');const m = t.match(/^(-?\d+(?:\.\d+)?)(?:\s*[\w/]+)?$/);return m ? Number(m[1]) : null; };
  function parse(html, previous) {
    if (!/<\/html>/i.test(html)) throw Error('EVDB-Antwort abgeschnitten; letzter Bestand bleibt erhalten.');
    const definitions = [], groups = {};
    const header = html.split('<div class="list-item" data-jplist-item>')[0];
    for (const match of header.matchAll(/<\w+\b([^>]*data-jplist-control="[^"]+"[^>]*)>/g)) {
      const a = attrs(match[1]), type = a['data-jplist-control'];
      if (type === 'slider-range-filter') {
        const path = a['data-path']?.slice(1), field = fields[path];
        if (!field) throw Error('Neuer EVDB-Bereichsfilter: ' + path);
        definitions.push({ field: field[0], label: field[1], unit: field[2], min: Number(a['data-min']), max: Number(a['data-max']), step: Number(a['data-step'] || 1), openMax: a['data-open-ended-max'] === 'true', unknown: ['safety','cargosort'].includes(path) });
      } else if (type === 'checkbox-path-filter') {
        const path = a['data-path'], group = a['data-or'] || 'features';
        if (!path) throw Error('Ungültige EVDB-Filterdefinition');
        const value = path.split('.').pop();
        groups[group] ||= { label: labels[group] || group, options: [] };
        if (!groups[group].options.some((o) => o.value === value)) groups[group].options.push({ value, label: labels[value] || (value.startsWith('size-') ? value.slice(5).toUpperCase() : value.startsWith('seats-') ? value.slice(6) + ' Sitze' : value) });
      }
    }
    const sortDefinitions = [...header.matchAll(/<div\b([^>]*class="jplist-dd-item"[^>]*)>/g)].map((m) => attrs(m[1]));
    const expectedSortPaths = ['rank','id','title','pricesort','pricesort','erange_real','battery','efficiency','priceperrange','safety','fastcharge_speed','acceleration','towweight','date_from','date_from','weight','cargo','long_distance_total'];
    if (JSON.stringify(sortDefinitions.map((a) => a['data-path']?.slice(1))) !== JSON.stringify(expectedSortPaths)) throw Error('EVDB-Sortierinventar geändert; bitte Parser aktualisieren.');
    const vehicles = [];
    for (const chunk of html.split('<div class="list-item" data-jplist-item>').slice(1)) {
      const id = chunk.match(/data-vehicle-id="(\d+)"/)?.[1];
      const title = chunk.match(/<a[^>]+class="title">([\s\S]*?)<\/a>/);
      const make = title?.[1].match(/<span class="([a-z0-9_]+)">([^<]+)<\/span>/);
      const model = title?.[1].match(/class="model">([\s\S]*?)<\/span>(?:<\/span>)?/);
      const status = chunk.match(/class="availability (current|upcoming|archive)"/)?.[1];
      if (!id || !make || !model || !status) throw Error('Unvollständiger EVDB-Fahrzeugdatensatz');
      const tokens = [...new Set([...chunk.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].filter((t) => Object.values(groups).some((g) => g.options.some((o) => o.value === t)) || t.startsWith('plug-'));
      const span = (name) => chunk.match(new RegExp('<span[^>]*class="' + name + '(?: [^"]*)?"[^>]*>([\\s\\S]*?)<\\/span>'))?.[1];
      const v = { id, make: text(make[2]), model: text(model[1]), title: text(make[2]) + ' ' + text(model[1]), status, tokens, shape: tokens.find((t) => t.startsWith('shape-'))?.slice(6), url: 'https://ev-database.org' + chunk.match(/href="(\/car\/[^" ]+)"/)?.[1], rank: number(span('rank')) };
      for (const [path, [field]] of Object.entries(fields)) if (!['pricefilter','year_from'].includes(path)) {
        if (span(path) === undefined) throw Error('EVDB-Kennzahl fehlt: ' + path);
        v[field] = number(span(path));
        if (v[field] < 0 || (field === 'cargoL' && v[field] === 0)) v[field] = null;
      }
      v.priceEur = number(span('country_de'));
      if (v.priceEur <= 0) v.priceEur = null;
      const from = number(span('date_from')), to = number(span('date_to'));
      v.availableFrom = from && from > 978307200 ? from : null;
      v.availableTo = status === 'archive' && to && to >= v.availableFrom ? to : null;
      v.yearFrom = v.availableFrom ? new Date(v.availableFrom * 1000).getUTCFullYear() : null;
      v.yearTo = v.availableTo ? new Date(v.availableTo * 1000).getUTCFullYear() : null;
      vehicles.push(v);
      const opt = groups.make?.options.find((o) => o.value === make[1]);if (opt) opt.label = v.make;
    }
    if (new Set(vehicles.map((v) => v.id)).size !== vehicles.length || vehicles.length < Math.max(1000, (previous?.vehicles?.length || 0) * .9) || definitions.length !== 12 || Object.keys(groups).length !== 9) throw Error('EVDB-Übersicht unvollständig oder Filterinventar geändert; letzter Bestand bleibt erhalten.');
    return { schemaVersion: 1, fetchedAt: new Date().toISOString(), source: 'https://ev-database.org/', units: Object.fromEntries(Object.values(fields).map(([key,,unit]) => [key,unit])), filters: { groups, ranges: definitions }, vehicles };
  }
  const key = (v) => 'evdb:' + v.id;
  function migrate(config, vehicles) {
    const out = { mapping: {}, prices: {} }, conflicts = [];
    for (const section of ['mapping','prices']) for (const [k, value] of Object.entries(config[section] || {})) {
      const matches = vehicles.filter((v) => v.make + '|' + v.model === k);
      if (k.startsWith('evdb:')) out[section][k] = value;
      else if (matches.length === 1 && !(key(matches[0]) in config[section])) out[section][key(matches[0])] = value;
      else { out[section][k] = value;conflicts.push(k); }
    }
    return { config: out, conflicts: [...new Set(conflicts)] };
  }
  function idPrices(data, vehicles, raw = false) {
    if (data.pricesByEvdbId) return { ...data.pricesByEvdbId, ...(raw ? data.originalPricesByEvdbId : {}) };
    const out = {};
    for (const v of vehicles) {
      const name = v.make + '|' + v.model;
      if (v.status === 'current' && data.prices?.[name]) out[key(v)] = (raw ? data.originalPrices?.[name] : null) || data.prices[name];
    }
    return out;
  }
  function legacy(prices, vehicles) {
    const out = {};
    for (const v of vehicles) if (prices[key(v)] && vehicles.filter((x) => x.make === v.make && x.model === v.model).length === 1) out[v.make + '|' + v.model] = prices[key(v)];
    return out;
  }
  function rows(database, prices, config, filters = {}, money) {
    const result = [];
    for (const v of database.vehicles) {
      const k = key(v);if (config.mapping[k] === null) continue;
      const p = !config.mapping[k]?.evdbOnly && (v.status === 'current' || config.mapping[k]) ? prices[k] : undefined, offer = filters.tag ? p?.offers?.find((o) => o.tag === filters.tag) : p;
      if (filters.tag && !offer) continue;
      const amount = money(offer?.endpreis), priceEur = amount ?? (filters.tag ? null : v.priceEur);
      const row = { ...v, ...(p || {}), priceEur, priceSource: amount !== null ? (offer.manualPrice ? 'APL · korrigiert' : 'APL') : priceEur === null ? 'Kein Preis' : 'EVDB-Listenpreis', pricePerKm: priceEur !== null && v.rangeKm > 0 ? priceEur / v.rangeKm : null };
      if (filters.query && !v.title.toLocaleLowerCase('de').includes(filters.query.toLocaleLowerCase('de'))) continue;
      if (filters.uncertain && !(p?.confidence < .85)) continue;
      if (filters.corrected && !(k in config.mapping) && !(k in config.prices)) continue;
      let matches = true;
      for (const [group, choices] of Object.entries(filters.groups || {})) if (choices.length) {
        const values = group === 'availability' ? [v.status] : v.tokens;
        if (group === 'features' ? !choices.every((t) => values.includes(t)) : !choices.some((t) => values.includes(t))) matches = false;
      }
      for (const def of database.filters.ranges) {
        const range = filters.ranges?.[def.field];if (!range) continue;
        const { min = def.min, max = def.max, unknown = false, unknownOnly = false } = range;
        if (unknownOnly) { if ((def.field === 'years' ? v.yearFrom : row[def.field]) != null) matches = false;continue; }
        if (min === def.min && max === def.max) continue;
        if (def.field === 'years') {
          if (v.yearFrom === null) { if (!unknown) matches = false; }
          else if (v.yearFrom > max || (v.yearTo ?? Infinity) < min) matches = false;
        } else {
          const value = row[def.field];
          if (value === null || value === undefined) { if (!unknown) matches = false; }
          else if (value < min || (!(def.openMax && max === def.max) && value > max)) matches = false;
        }
      }
      if (matches) result.push([k, row]);
    }
    const [, ,field, defaultDirection] = sorts.find((s) => s[0] === (filters.sort || 'rank')) || sorts[0];
    const direction = filters.direction || defaultDirection;
    return result.sort((a,b) => {
      const x = field === 'id' ? Number(a[1].id) : a[1][field], y = field === 'id' ? Number(b[1].id) : b[1][field];
      if (x == null) return y == null ? 0 : 1;if (y == null) return -1;
      const comparison = (typeof x === 'string' ? x.localeCompare(y, 'de') : x-y) * direction;
      if (!comparison && field === 'towingKg') return (b[1].availableFrom || 0) - (a[1].availableFrom || 0);
      return comparison;
    });
  }
  const api = { parse, number, key, labels, fields, sorts, migrate, idPrices, legacy, rows };
  global.EVDB = api;if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
