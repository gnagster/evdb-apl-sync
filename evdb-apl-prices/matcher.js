// Pure matching logic: ev-database.org model -> apl.de model slug.
// Works in the MV3 service worker (via importScripts) and in Node (require).
// Exports: slugify, aplMakeSlug, cleanModel, score, specKwhOf, specMatch,
// buildMapping, MIN_SCORE. Attached to global.APLMatcher AND module.exports.
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
    /\b(standard|premium|performance|excellence|launch edition|base|basis|comfort|ambition|business|family|active|elegance|dynamic|life|edition|signature|exclusive( plus)?|ultimate|gt|gtx|gse|style|neo|max|pro|plus|design|flagship|turbo|rally|er|sr|lwb|nwb|privilege|core|xpower|boost)\b/gi,
    /\bp\d+\b/gi, // Volvo battery badges (EX30 P5, EX60 P12)
    /\b(hatchback|sedan|liftback sedan|suv|cabriolet|cabrio|convertible|coupe|station|estate|mpv|limousine|touring|4-door|5-door)\b/gi,
    /\b(e-tech|etech|e-tense|e-power|electric|phev|plug-in hybrid|hybrid|gti|tfsi-e|tfsi|dm-i|48v|mhev|r-ev|e-4orce|4orce)\b/gi,
    /\b(se|jcw|all4|xl|xxl|l1|l2|l3)\b/gi, // mini trims, wheelbases, lengths
    /\bev\b/gi, // standalone "EV" marker (not EV3/EV60 model names)
  ];

  // Strip bare numbers that are clearly trims (preceded by whitespace/start,
  // followed by whitespace/end): "e-tron 55", "C 400", "CLA 250+" -> "250".
  // Numbers that are part of the model name ("IONIQ 3", "ATTO 3", "Epiq 55")
  // must survive. cleanModel() therefore keeps BOTH cores: `a` with the
  // number intact, `b` with it stripped. Matching uses `a` first; `b` is a
  // fallback whose use is gated in buildMapping() against family-prefix
  // ambiguity (see familyPrefixAmbiguous) so a real model number like IONIQ
  // 3's "3" never collapses to the shared family prefix "ioniq".
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

  // kWh from an evdb model name ("Kia EV4 Hatchback 81.4 kWh" -> 81.4,
  // "Renault 5 E-Tech 52kWh" -> 52, no match -> null). Decimal-safe.
  function specKwhOf(name) {
    const m = String(name).match(/(\d+(?:\.\d+)?)\s*kWh/i);
    return m ? parseFloat(m[1]) : null;
  }

  /**
   * Compare evdb battery/motor specs against one APL variant line.
   * Pure helper for the pipeline: after buildMapping() picks a slug, the
   * pipeline fetches the APL detail page (e.g. .../kia/ev4/air/), parses
   * data-sortmotor ("81,4 kWh" -> 81.4) and data-sortkw ("150" kW), and
   * calls specMatch(specKwhOf(evdbModel), evdbTotalPowerKw,
   *                aplKwh, aplKw) to decide whether that variant is the
   * base trim or a different battery/motor configuration.
   * Tolerances: kWh within 15% OR 5 kWh; kW within 25% OR 30 kW.
   * score is the fraction of known spec dims that agree (0..1).
   */
  function specMatch(evdbKwh, evdbKw, aplKwh, aplKw) {
    const kwhKnown = evdbKwh != null && aplKwh != null;
    const kwKnown = evdbKw != null && aplKw != null;
    const kwhOk =
      kwhKnown &&
      (Math.abs(evdbKwh - aplKwh) <= 5 || Math.abs(evdbKwh - aplKwh) / aplKwh <= 0.15);
    const kwOk =
      kwKnown &&
      (Math.abs(evdbKw - aplKw) <= 30 || Math.abs(evdbKw - aplKw) / aplKw <= 0.25);
    const n = (kwhKnown ? 1 : 0) + (kwKnown ? 1 : 0);
    return {
      kwhOk,
      kwOk,
      score: n ? ((kwhOk ? 1 : 0) + (kwOk ? 1 : 0)) / n : 0,
    };
  }

  function cleanModel(make, model, shape) {
    const mk = aplMakeSlug(make); // aliased makes ('ds-automobiles'->'ds') so make-prefix strip + MODEL_ALIAS apply
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
          .filter((t, i) => !(i > 0 && /^\d+x$/.test(t))) // Škoda AWD badges (85x, 90x) - but "7x" alone is a model
          .filter((t, i, arr) => !(t === 'e' && i === arr.length - 1))
          .join('-');
      }
      return slug;
    };

    const rawSlug = slugify(s);
    const coreA = stripTrimTokens(rawSlug);
    // Only produce the number-stripped core when BARE_NUM actually stripped
    // a bare number and left a real token: never when the number is the
    // entire remaining core (empty) or the strip collapses to a single
    // letter/number ("C 400" -> "c" is not a usable model core — the alias
    // on coreA covers it).
    let coreB = null;
    {
      const strippedSlug = slugify(s.replace(BARE_NUM_RE, ' '));
      if (strippedSlug !== rawSlug && strippedSlug.length >= 2) coreB = strippedSlug;
    }
    // Some APL model lines have no "e-" prefix (Ford "tourneo-custom").
    const coreC = coreA.startsWith('e-') ? coreA.slice(2) : null;

    const stripMakePrefix = (c) =>
      c.startsWith(mk + '-') ? c.slice(mk.length + 1) : c;

    const a = stripMakePrefix(coreA);
    const b = coreB ? stripMakePrefix(coreB) : null;
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
      b: b && (alias[b] || b),
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

  // A stripped core (cleanModel().b) that prefixes APL slugs with a trailing
  // NUMBER ("ioniq" -> ioniq-5/6/9, "atto" -> atto-2) is a family name, not a
  // base model: matching through it turns a real evdb model number ("IONIQ 3",
  // "ATTO 3") into a wrong sibling. coreB is unusable when a number-tailed
  // sibling exists but none of them agrees with the evdb model's number.
  function coreBNumberConflict(core, coreA, models) {
    const numA = (coreA.match(/\d+(?:\.\d+)?/) || [null])[0];
    if (numA == null) return false; // no evdb number to protect -> strip is fine
    let sawNumberTail = false;
    for (const m of models) {
      if (m.length > core.length && m.startsWith(core) && score(m, core) >= MIN_SCORE) {
        const tail = m.slice(core.length); // e.g. "-5", "-suv"
        if (!/^-\d+(?:\.\d+)?$/.test(tail)) continue;
        sawNumberTail = true;
        if (tail.slice(1) === numA) return false; // agreeing sibling exists -> coreB is safe
      }
    }
    return sawNumberTail; // only disagreeing number tails -> reject coreB
  }

  // Confidence 0..1 for one mapping. Starts from the raw score and adjusts
  // for match quality signals (all penalties/boosts are small except a
  // conflicting model NUMBER, which means the wrong sibling was picked).
  function confidenceOf(v, cores, slug, sc, coreKey) {
    let c = sc;
    const numA = (cores.a.match(/\d+(?:\.\d+)?/) || [null])[0];
    const numS = (slug.match(/\d+(?:\.\d+)?/) || [null])[0];
    // evdb core number != APL slug number -> sibling collision ("IONIQ 3"
    // vs "ioniq-5", "Enyaq 85" vs "enyaq-coupe" is fine, no number).
    if (numA != null && numS != null && numA !== numS) c -= 0.35;
    // Match only reachable through the number-stripped core is slightly
    // weaker (the number was dropped, so the model identity leans on the
    // remaining core alone).
    if (coreKey === 'b' && score(slug, cores.a) < 0.6) c -= 0.05;
    // Body-shape keyword hit on the slug confirms the right body variant.
    if (cores.shape.some((k) => slug.includes(k))) c += 0.03;
    // kWh in the evdb name confirms a real model, not a trim artifact.
    if (specKwhOf(v.model) != null && (sc >= 0.95 || slug === cores.a)) c += 0.02;
    return Math.max(0, Math.min(1, c));
  }

  /**
   * Build evdb->APL mapping.
   * Assumption: evdb models are the BASE trims. The scorer therefore strips
   * trim words (STRIP_RE) and its tie-break prefers the shortest slug — i.e.
   * the base model over the same model with a trim suffix ("4-urban" over
   * "4-urban-plus", "q4-e-tron" over "q4-sportback-e-tron").
   * @param vehicles [{make, model, shape?}]
   * @param aplSlugs ['/neuwagen/{make}/{model}/modellvarianten/']
   * @returns {{mapping:Object<string,string>, unmatched:Array<{make,model,key}>,
   *           candidates:Object<string,string[]>,
   *           confidence:Object<string,number>, lowConfidence:string[]}}
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
    const confidence = {};

    const pick = (mk, cores) => {
      const models = byMake.get(mk);
      if (!models) return null;
      // usableCores: 'a' first (number intact), 'b' gated against family-
      // prefix ambiguity, 'c' as e-less fallback.
      const usableCores = [];
      for (const [key, core] of [
        ['a', cores.a],
        ['b', cores.b],
        ['c', cores.c],
      ]) {
        if (!core) continue;
        if (key === 'b' && coreBNumberConflict(core, cores.a, models)) continue;
        usableCores.push({ key, core });
      }
      const coreScore = (m, core) => score(m, core);
      const maxScore = (m) => Math.max(...usableCores.map(({ core }) => coreScore(m, core)));
      let best = null;
      for (const { key, core } of usableCores) {
        for (const m of models) {
          const sc = coreScore(m, core);
          if (sc >= MIN_SCORE && (!best || sc > best.score)) {
            best = { slug: m, score: sc, core: key };
          }
        }
      }
      if (!best) return null;
      // Tie-break among near-best candidates (within 0.1):
      // 1) body-shape keyword match, 2) electric marker, 3) shortest (base
      //    trim preference), 4) alpha.
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
      const winner = near[0];
      return { slug: winner.m, score: winner.sc, core: argMaxCore(winner.m) };

      function argMaxCore(slug) {
        let bk = 'a', bs = -1;
        for (const { key, core } of usableCores) {
          const sc = coreScore(slug, core);
          if (sc > bs) {
            bs = sc;
            bk = key;
          }
        }
        return bk;
      }

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
        confidence[key] = confidenceOf(v, cores, best.slug, best.score, best.core);
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

    const lowConfidence = Object.keys(confidence).filter((k) => confidence[k] < 0.85);
    return { mapping, unmatched, candidates, confidence, lowConfidence };
  }

  global.APLMatcher = {
    slugify,
    aplMakeSlug,
    cleanModel,
    score,
    specKwhOf,
    specMatch,
    buildMapping,
    MIN_SCORE,
  };
  // Use the explicit property (not the bare identifier) so a caller's
  // top-level `const APLMatcher` in its own scope can never shadow this
  // module's global lookup (node -e puts such declarations in the global
  // lexical scope and would break require() in TDZ).
  if (typeof module !== 'undefined' && module.exports) module.exports = global.APLMatcher;
})(typeof globalThis !== 'undefined' ? globalThis : this);
