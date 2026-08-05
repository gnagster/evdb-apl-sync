// Pure matching logic: ev-database.org model -> apl.de model slug.
// Works in the MV3 service worker (via importScripts) and in Node (require).
'use strict';

(function (global) {
  // evdb make -> APL make slug overrides (everything else normalizes 1:1).
  const MAKE_ALIAS = {
    vw: 'vw',
    volkswagen: 'vw',
    'ds-automobiles': 'ds',
    ds: 'ds',
  };

  // Per-make model aliases for names that don't normalize cleanly.
  const MODEL_ALIAS = {
    renault: { 5: 'r5-e-tech', 4: 'r4-e-tech' },
    mg: { mg4: '4-urban', 'mg4-electric': '4-urban', 'mg4-urban': '4-urban', 4: '4-urban' },
    fiat: { '500e': '500e-3-plus1', '500e-3-1': '500e-3-plus1', '600e': '600-elektro' },
    'mercedes-benz': { 'c-400': 'c-klasse-limousine', c: 'c-klasse-limousine' },
    nissan: { 'townstar-passenger': 'townstar-kombi' },
    ds: { 3: 'ds3' },
  };

  function slugify(s) {
    return String(s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function aplMakeSlug(evdbMake) {
    const s = slugify(evdbMake);
    return MAKE_ALIAS[s] || s;
  }

  // Applied to the raw model string, BEFORE slugifying. Never strips bare
  // numbers (they are model names: 208, i3, ID.3, IONIQ 5).
  const STRIP_RE = [
    /\bmy\d{2}(?:-\d{2})?\b/gi, // MY25, MY22-25
    /\b\d+(?:[.,]\d+)?\s*(?:kwh|kw|hp|ps|ah|cc)\b/gi, // 64 kWh, 150 kW, 220 hp
    /\b(rwd|awd|fwd|2wd|4wd|4x4|4-matic|4matic|xdrive\d*|sdrive\d*|edrive\d*|quattro)\b/gi, // drivetrains
    /\bm\d+\b/gi, // BMW M trims (M50, M60) - M3/M5 as model names are not EVs
    /\b(long range|standard range( plus)?|extended range|short range|comfort range)\b/gi,
    /\b(standard|premium|performance|excellence|launch edition|base|basis|comfort|ambition|business|family|active|elegance|dynamic|life|edition|signature|exclusive( plus)?|ultimate|gt|gtx|gse|style|neo|max|pro|plus|design|flagship|turbo|rally|er|sr|lwb|nwb|privilege|core|xpower)\b/gi,
    /\b(hatchback|sedan|liftback sedan|suv|cabriolet|cabrio|convertible|coupe|station|estate|mpv|limousine|touring|4-door|5-door)\b/gi,
    /\b(e-tech|etech|e-tense|e-power|electric|phev|plug-in hybrid|hybrid|gti|tfsi-e|tfsi|dm-i|48v|mhev|r-ev|e-4orce|4orce)\b/gi,
    /\b(se|jcw|all4|xl|xxl|l1|l2|l3)\b/gi, // mini trims, wheelbases, lengths
    /\bev\b/gi, // standalone "EV" marker (not EV3/EV60 model names)
  ];

  // Strip bare numbers that are clearly trims (preceded by whitespace/start,
  // followed by whitespace/end): "e-tron 55", "C 400", "CLA 250+" -> "250".
  const BARE_NUM_RE = /(^|\s)\d+(?:[.,]\d+)?(?=\s|$)/g;

  // evdb body shape -> APL slug keyword preference.
  const SHAPE_KEYWORDS = {
    suv: ['suv'],
    cabrio: ['cabrio'],
    coupe: ['coup'],
    sedan: ['limousine', '4-tuerer'],
    liftback: ['sportback', 'fastback', 'limousine'],
    station: ['touring', 'sports-tourer', 'shooting-brake', 'kombi', 'station', 'sw'],
    spv: ['verso', 'traveller', 'traveler', 'kombi', 'space', 'tourneo', 'combo'],
    mpv: ['verso', 'traveller', 'traveler', 'space', 'tourneo', 'combo'],
  };

  // Body words in the raw model name act as shape hints (evdb's own shape
  // class is coarse: "500e Convertible" comes through as hatchback).
  const NAME_SHAPE_HINTS = {
    cabriolet: 'cabrio', cabrio: 'cabrio', convertible: 'cabrio', drophead: 'cabrio',
    coup: 'coupe', '2-door': 'coupe',
    sportback: 'liftback', fastback: 'liftback',
    'shooting brake': 'station', tourer: 'station', estate: 'station', wagon: 'station', kombi: 'station',
    limousine: 'sedan',
    suv: 'suv',
  };

  function cleanModel(make, model, shape) {
    const mk = slugify(make);
    let s = String(model);
    s = s.replace(/\([^)]*\)/g, ' '); // (MY25), (Highland), (Juniper)
    s = s.replace(/\+/g, ' '); // "CLA 250+", "C 400 4MATIC+" -> "+" is not part of names
    for (const re of STRIP_RE) s = s.replace(re, ' ');

    // Drop trim tokens like "EV60"/"EV87" and a trailing standalone "e"
    // (Mini "Aceman E") when the model has other content. Leading "e" is a
    // model prefix ("e-tron", "e-208", "e-Vitara") and must survive.
    const stripTrimTokens = (slug) => {
      const toks = slug.split('-').filter(Boolean);
      if (toks.length > 1) {
        return toks
          .filter((t, i) => !(i > 0 && /^ev\d+$/.test(t)))
          .filter((t, i, arr) => !(t === 'e' && i === arr.length - 1))
          .join('-');
      }
      return slug;
    };

    const coreA = stripTrimTokens(slugify(s));
    const coreB = stripTrimTokens(slugify(s.replace(BARE_NUM_RE, ' ')));
    // Some APL model lines have no "e-" prefix (Ford "tourneo-custom").
    const coreC = coreA.startsWith('e-') ? coreA.slice(2) : null;

    const stripMakePrefix = (c) =>
      c.startsWith(mk + '-') ? c.slice(mk.length + 1) : c;

    const a = stripMakePrefix(coreA);
    const b = stripMakePrefix(coreB);
    const c = coreC ? stripMakePrefix(coreC) : null;
    const alias = MODEL_ALIAS[mk] || {};
    const shapeKeys = new Set((SHAPE_KEYWORDS[shape] || []).map((k) => `-${k}`));
    for (const [word, s2] of Object.entries(NAME_SHAPE_HINTS)) {
      if (String(model).toLowerCase().includes(word)) {
        for (const k of SHAPE_KEYWORDS[s2] || []) shapeKeys.add(`-${k}`);
      }
    }
    return {
      a: alias[a] || a,
      b: alias[b] || b,
      c: c && (alias[c] || c),
      shape: [...shapeKeys],
    };
  }

  function tokenize(s) {
    return s.split('-').filter(Boolean);
  }

  // Score how well an APL model slug matches an evdb core slug. 1.0 = exact.
  function score(aplSlug, coreSlug) {
    if (!coreSlug) return 0;
    if (aplSlug === coreSlug) return 1.0;
    let s = 0;
    if (coreSlug.length >= 2 && aplSlug.startsWith(coreSlug)) {
      s = 0.9;
    } else if (aplSlug.length >= 3 && coreSlug.startsWith(aplSlug)) {
      s = 0.85;
    } else {
      const a = tokenize(aplSlug);
      const c = tokenize(coreSlug);
      const inter = a.filter((t) => c.includes(t)).length;
      const jac = inter / (a.length + c.length - inter || 1);
      if (jac >= 0.6) s = 0.5 + 0.45 * jac;
      else return 0;
    }
    // evdb is an EV database: nudge electric-trimmed APL models.
    if (/\belectric\b|^e-|-e-tron|-e-tech|-ev$|elektro/.test(aplSlug)) s += 0.03;
    return s;
  }

  const MIN_SCORE = 0.85;

  /**
   * Build evdb->APL mapping.
   * @param vehicles [{make, model, shape?}]
   * @param aplSlugs ['/neuwagen/{make}/{model}/modellvarianten/']
   * @returns {{mapping:Object<string,string>, unmatched:Array<{make,model,key}>,
   *           candidates:Object<string,string[]>}}
   */
  function buildMapping(vehicles, aplSlugs) {
    const byMake = new Map(); // apl make -> Set of model slugs
    for (const u of aplSlugs) {
      const parts = u.split('/').filter(Boolean); // [neuwagen, make, model, modellvarianten]
      if (parts.length < 4) continue;
      const mk = parts[1];
      if (!byMake.has(mk)) byMake.set(mk, new Set());
      byMake.get(mk).add(parts[2]);
    }

    const mapping = {};
    const unmatched = [];
    const candidates = {};

    const pick = (mk, cores) => {
      const models = byMake.get(mk);
      if (!models) return null;
      const allCores = [cores.a, cores.b, cores.c].filter(Boolean);
      const maxScore = (m) => Math.max(...allCores.map((core) => score(m, core)));
      let best = null;
      for (const core of allCores) {
        for (const m of models) {
          const sc = score(m, core);
          if (sc >= MIN_SCORE && (!best || sc > best.score)) {
            best = { slug: m, score: sc, core };
          }
        }
      }
      if (!best) return null;
      // Tie-break among near-best candidates (within 0.1):
      // 1) body-shape keyword match, 2) electric marker, 3) shortest, 4) alpha.
      const near = [...models]
        .map((m) => ({ m, sc: maxScore(m) }))
        .filter((x) => x.sc >= best.score - 0.1);
      near.sort((x, y) => {
        const xs = rank(x.m, cores), ys = rank(y.m, cores);
        if (xs !== ys) return xs - ys;
        if (x.sc !== y.sc) return y.sc - x.sc;
        if (x.m.length !== y.m.length) return x.m.length - y.m.length;
        return x.m < y.m ? -1 : 1;
      });
      return { slug: near[0].m, score: near[0].sc };

      function rank(slug, c) {
        const sh = c.shape.find((k) => slug.includes(k));
        const el = /\belectric\b|^e-|-e-tron|-e-tech|-ev$|elektro/.test(slug);
        if (sh) return el ? 0 : 1;
        return el ? 2 : 3;
      }
    };

    for (const v of vehicles) {
      const key = `${v.make}|${v.model}`;
      const mk = aplMakeSlug(v.make);
      const cores = cleanModel(v.make, v.model, v.shape);
      const best = pick(mk, cores);
      if (best) {
        mapping[key] = best.slug;
      } else {
        unmatched.push({ make: v.make, model: v.model, key });
        const models = byMake.get(mk) || new Set();
        const maxScore = (m) =>
          Math.max(
            ...[cores.a, cores.b, cores.c].filter(Boolean).map((core) => score(m, core))
          );
        candidates[key] = [...models]
          .map((m) => ({ m, s: maxScore(m) }))
          .filter((x) => x.s >= 0.4)
          .sort((x, y) => y.s - x.s)
          .slice(0, 6)
          .map((x) => x.m);
      }
    }
    return { mapping, unmatched, candidates };
  }

  global.APLMatcher = {
    slugify,
    aplMakeSlug,
    cleanModel,
    score,
    buildMapping,
    MIN_SCORE,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
