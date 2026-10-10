'use strict';
(function (global) {
  const TAGS = ['für Privatkunden', 'für Geschäftskunden', 'für Freiberufler'];
  const FIELDS = ['endpreis', 'kaufpreis', 'ersparnis', 'lieferzeit'];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const empty = () => ({ mapping: {}, prices: {} });
  function money(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value ?? '').replace(/[€\s]/g, '');
    if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(text)) return null;
    return Number(text.replace(/\./g, '').replace(',', '.'));
  }
  function sourceId(s) {
    return s ? [s.slug, s.variantId, s.motorId, s.tariffId].join('/') : '';
  }
  function validateSource(s) {
    if (!s || !/^[a-z0-9-]+$/.test(s.slug) || !/^\d+$/.test(s.variantId) ||
        !/^\d+$/.test(s.motorId) || !/^\d*$/.test(s.tariffId)) throw new Error('Ungültige Preisquelle.');
  }
  function validate(config) {
    if (!config || !config.mapping || !config.prices || Array.isArray(config.mapping) || Array.isArray(config.prices)) throw new Error('Ungültige Korrekturdatei.');
    for (const section of [config.mapping, config.prices]) {
      if (typeof section !== 'object') throw new Error('Ungültige Korrekturen.');
      for (const key of Object.keys(section)) {
        if (!/^[^|]+\|[^|]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Ungültiger Fahrzeugschlüssel.');
      }
    }
    for (const m of Object.values(config.mapping)) {
      if (m === null) continue;
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Ungültige Zuordnung.');
      if (m.slug && !/^[a-z0-9-]+$/.test(m.slug)) throw new Error('Ungültiges APL-Modell.');
      if (m.base) validateSource(m.base);
      for (const [tag, source] of Object.entries(m.offers || {})) {
        if (!TAGS.includes(tag)) throw new Error('Unbekannte Kundenart.');
        validateSource(source);
      }
      if (!m.slug && !m.base && !Object.keys(m.offers || {}).length) throw new Error('Leere Zuordnung.');
    }
    for (const p of Object.values(config.prices)) {
      const values = [['base', p.base], ...Object.entries(p.offers || {})];
      for (const [tag, patch] of values) {
        if (!patch) continue;
        if (tag !== 'base' && !TAGS.includes(tag)) throw new Error('Unbekannte Kundenart.');
        validateSource(patch.source);
        if (!patch.values || !Object.keys(patch.values).length) throw new Error('Leere Preiskorrektur.');
        for (const [field, value] of Object.entries(patch.values)) {
          if (!FIELDS.includes(field) || typeof value !== 'string' || value.length > 200) throw new Error('Ungültiges Preisfeld.');
          if (['endpreis', 'kaufpreis'].includes(field) && (money(value) === null || money(value) <= 0)) throw new Error('Bitte einen positiven Preis eingeben.');
          if (field === 'ersparnis' && !/^\d[\d.,]*(?:\s*\(\d[\d.,]*\))?$/.test(value)) throw new Error('Ungültige Ersparnis.');
        }
      }
    }
    return config;
  }
  function sourceOffer(ref, tag, cache) {
    validateSource(ref);
    const variant = (cache.slugLines[ref.slug]?.lines || []).find((v) => v.id === ref.variantId);
    if (!variant) throw new Error('APL-Variante nicht gefunden: ' + sourceId(ref));
    const offer = (cache.lineData[ref.variantId]?.data.offers?.[ref.motorId] || [])
      .find((o) => o.tag === tag && o.tariffId === ref.tariffId);
    if (!offer) throw new Error('APL-Angebot nicht gefunden: ' + sourceId(ref));
    return { ...clone(offer), source: { ...ref, variantName: variant.name, url: variant.url,
      ...(cache.motorSpecs[ref.motorId] || {}), fetchedAt: cache.lineData[ref.variantId].fetchedAt } };
  }
  function applyMappings(prices, config, cache) {
    const out = clone(prices);
    for (const [key, m] of Object.entries(config.mapping)) {
      if (m === null) { delete out[key]; continue; }
      if (!out[key]) throw new Error('Fahrzeug hat keinen Abrufwert: ' + key);
      if (m.base) {
        const base = sourceOffer(m.base, TAGS[0], cache);
        for (const f of FIELDS) out[key][f] = base[f];
        out[key].source = base.source;
        out[key].slug = m.base.slug;
      }
      for (const [tag, ref] of Object.entries(m.offers || {})) {
        const offer = sourceOffer(ref, tag, cache);
        out[key].offers = (out[key].offers || []).filter((o) => o.tag !== tag);
        out[key].offers.push(offer);
      }
      out[key].manualMapping = true;
    }
    return out;
  }
  function applyPrices(prices, config) {
    const out = clone(prices), originals = {}, warnings = [];
    for (const [key, p] of Object.entries(config.prices)) {
      if (!out[key]) continue;
      originals[key] = clone(out[key]);
      for (const [tag, patch] of [['base', p.base], ...Object.entries(p.offers || {})]) {
        if (!patch) continue;
        const target = tag === 'base' ? out[key] : (out[key].offers || []).find((o) => o.tag === tag);
        if (!target || sourceId(target.source) !== sourceId(patch.source)) {
          warnings.push(key + ': Preiskorrektur passt nicht mehr zur Quelle (' + tag + ').'); continue;
        }
        Object.assign(target, patch.values, { manualPrice: true });
      }
    }
    return { prices: out, originalPrices: originals, warnings };
  }
  function rawPrices(data) { return { ...clone(data.prices || {}), ...clone(data.originalPrices || {}) }; }
  function references(entry) { return [entry?.source, ...(entry?.offers || []).map((o) => o.source)].filter(Boolean); }
  function affected(prices, variantIds) {
    const ids = new Set(variantIds);
    return Object.keys(prices).filter((key) => references(prices[key]).some((s) => ids.has(s.variantId)));
  }
  function filterRows(prices, config, filters = {}) {
    const query = (filters.query || '').toLocaleLowerCase('de');
    const rows = Object.entries(prices).filter(([key, entry]) => {
      if (query && !key.toLocaleLowerCase('de').includes(query)) return false;
      if (filters.make && key.split('|')[0] !== filters.make) return false;
      if (filters.uncertain && entry.confidence >= 0.85) return false;
      if (filters.corrected && !(key in config.mapping) && !(key in config.prices)) return false;
      const offers = filters.tag ? (entry.offers || []).filter((o) => o.tag === filters.tag) : [entry];
      const amounts = offers.map((o) => money(o.endpreis)).filter((n) => n !== null);
      if (filters.tag && !offers.length) return false;
      if (filters.min !== null && filters.min !== undefined && !amounts.some((p) => p >= filters.min)) return false;
      if (filters.max !== null && filters.max !== undefined && !amounts.some((p) => p <= filters.max)) return false;
      return true;
    });
    const sort = filters.sort || 'model', direction = filters.direction || 1;
    const value = ([key, entry]) => sort === 'model' ? key : sort === 'confidence' ? entry.confidence :
      money((filters.tag ? entry.offers?.find((o) => o.tag === filters.tag) : entry)?.endpreis);
    return rows.sort((a, b) => {
      const x = value(a), y = value(b);
      if (x === null || x === undefined) return y == null ? 0 : 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === 'string' ? x.localeCompare(y, 'de') : x - y) * direction;
    });
  }
  const core = { TAGS, FIELDS, clone, empty, money, sourceId, validate, validateSource, sourceOffer,
    applyMappings, applyPrices, rawPrices, references, affected, filterRows };
  global.APLDashboard = core;
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
