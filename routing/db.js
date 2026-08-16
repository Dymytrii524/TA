'use strict';
/**
 * Mock data-source adapters standing in for the databases named on the
 * flowchart ("Б-р море", "Б-р мульт жд", "Б.д. жд станцій", ...).
 *
 * Each adapter has the same shape:
 *   { source, terminals: [{id,name,lat,lon,country}], directRoutes: Set("from|to") }
 * and the same three methods, so the routing core never needs to know which
 * concrete source it's talking to.
 *
 * These are in-memory stand-ins so the algorithms can be run and tested
 * without live credentials. To wire in real data, replace the body of
 * `makeSubDb` (or a specific adapter's terminals/directRoutes) with calls to
 * the actual providers, e.g.:
 *   - global sea:      a vessel-schedule / freight-booking API (AIS + carrier schedules)
 *   - multimodal sea:  a combined rail+sea booking platform
 *   - basin/internal sea: a national port authority's own cargo register
 *   - global/domestic rail: national rail-freight operators' open data feeds
 *   - road:            this site's own cargo/transport exchange listings
 *   - rail stations:   a national rail-infrastructure operator's station registry
 * The routing core in core.js does not change when you do this.
 */

function makeSubDb(source, terminals, directPairs) {
  const directRoutes = new Set(directPairs.map(([a, b]) => `${a}|${b}`).concat(
    directPairs.map(([a, b]) => `${b}|${a}`) // freight routes are usable both directions
  ));
  return {
    source,
    terminals,
    hasEndpoint(id) {
      return terminals.some((t) => t.id === id);
    },
    findDirect(fromId, toId) {
      return directRoutes.has(`${fromId}|${toId}`) ? { source } : null;
    },
  };
}

/** Combines global + multimodal + domestic/basin sub-DBs, exactly like the
 * flowchart's "Б-р X(звідки,куди) / Б-р мульт X / Б-р внутр X" triads, which
 * are always queried together and in that priority order. */
function makeGroup(name, subDbs) {
  return {
    name,
    subDbs,
    allTerminals() {
      const map = new Map();
      for (const db of subDbs) for (const t of db.terminals) map.set(t.id, t);
      return [...map.values()];
    },
    hasEndpoint(id) {
      return subDbs.some((db) => db.hasEndpoint(id));
    },
    findDirect(fromId, toId) {
      for (const db of subDbs) {
        const hit = db.findDirect(fromId, toId);
        if (hit) return hit;
      }
      return null;
    },
  };
}

// ---- terminals (reuses the city set from the Trans-Atlas site + a few extra
// test fixtures to exercise every branch of the algorithm) ----
const T = {
  kyiv: { id: 'kyiv', name: 'Kyiv', lat: 50.4501, lon: 30.5234, country: 'UA' },
  lviv: { id: 'lviv', name: 'Lviv', lat: 49.8397, lon: 24.0297, country: 'UA' },
  odesa: { id: 'odesa', name: 'Odesa', lat: 46.4825, lon: 30.7233, country: 'UA' },
  warsaw: { id: 'warsaw', name: 'Warsaw', lat: 52.2297, lon: 21.0122, country: 'PL' },
  krakow: { id: 'krakow', name: 'Krakow', lat: 50.0647, lon: 19.945, country: 'PL' },
  gdansk: { id: 'gdansk', name: 'Gdansk', lat: 54.352, lon: 18.6466, country: 'PL' },
  berlin: { id: 'berlin', name: 'Berlin', lat: 52.52, lon: 13.405, country: 'DE' },
  hamburg: { id: 'hamburg', name: 'Hamburg', lat: 53.5511, lon: 9.9937, country: 'DE' },
  munich: { id: 'munich', name: 'Munich', lat: 48.1351, lon: 11.582, country: 'DE' },
  vilnius: { id: 'vilnius', name: 'Vilnius', lat: 54.6872, lon: 25.2797, country: 'LT' },
  prague: { id: 'prague', name: 'Prague', lat: 50.0755, lon: 14.4378, country: 'CZ' },
  vienna: { id: 'vienna', name: 'Vienna', lat: 48.2082, lon: 16.3738, country: 'AT' },
  rotterdam: { id: 'rotterdam', name: 'Rotterdam', lat: 51.9244, lon: 4.4777, country: 'NL' },
  istanbul: { id: 'istanbul', name: 'Istanbul', lat: 41.0082, lon: 28.9784, country: 'TR' },
  constanta: { id: 'constanta', name: 'Constanta', lat: 44.1733, lon: 28.6383, country: 'RO' },
  klaipeda: { id: 'klaipeda', name: 'Klaipeda', lat: 55.7033, lon: 21.1443, country: 'LT' },
  ternopil: { id: 'ternopil', name: 'Ternopil', lat: 49.5535, lon: 25.5948, country: 'UA' }, // deliberately in no DB -> exercises the nearest-point fallback
  nowhere: { id: 'nowhere', name: 'Test point with no nearby infrastructure', lat: 20, lon: 20, country: 'ZZ' }, // synthetic fixture -> exercises the ultimate pure-auto fallback
};

// ---- Sea ("Б-р море" / "Б-р мульт море" / "Б-р внутр море") ----
const seaGlobal = makeSubDb(
  'Б-р море (глобальні джерела)',
  [T.rotterdam, T.istanbul, T.constanta, T.gdansk],
  [
    ['rotterdam', 'istanbul'],
    ['rotterdam', 'constanta'],
    ['gdansk', 'istanbul'],
  ]
);
const seaMultimodal = makeSubDb(
  'Б-р мульт море (мультимодальні джерела)',
  [T.hamburg, T.constanta, T.istanbul],
  [['hamburg', 'constanta']]
);
const seaBasin = makeSubDb(
  'Б-р внутр море (внутрішньобасейнові джерела, Балтика)',
  [T.gdansk, T.klaipeda, T.rotterdam],
  [
    ['gdansk', 'klaipeda'],
    ['klaipeda', 'rotterdam'],
  ]
);
const seaGroup = makeGroup('морський', [seaGlobal, seaMultimodal, seaBasin]);

// ---- Rail ("Б-р жд" / "Б-р мульт жд" / "Б-р внутр жд") ----
const railGlobal = makeSubDb(
  'Б-р жд (глобальні джерела)',
  [T.kyiv, T.munich, T.prague, T.hamburg],
  [
    ['kyiv', 'munich'],
    ['prague', 'hamburg'],
  ]
);
const railMultimodal = makeSubDb(
  'Б-р мульт жд (мультимодальні джерела)',
  [T.istanbul, T.prague],
  [['istanbul', 'prague']]
);
const railDomestic = makeSubDb(
  'Б-р внутр жд (Україна)',
  [T.kyiv, T.lviv],
  [['kyiv', 'lviv']]
);
const railGroup = makeGroup('залізничний', [railGlobal, railMultimodal, railDomestic]);

// ---- Air (needed for the plane+auto algorithm) ----
const airGlobal = makeSubDb(
  'Б-р авіа (глобальні джерела)',
  [T.munich, T.kyiv, T.vienna, T.odesa, T.istanbul],
  [
    ['munich', 'kyiv'],
    ['vienna', 'odesa'],
  ]
);
const airGroup = makeGroup('авіа', [airGlobal]);

// ---- Road ("Б-р авто") - the universal connector; a DB hit means a
// confirmed listing (like the ones on the Trans-Atlas exchange itself),
// but unlike sea/rail/air, trucking is assumed to always be physically
// possible, so the routing core allows an *unconfirmed* auto leg as a
// last resort where the flowchart shows a plain "авто" leaf (no "ДАННІ"
// prefix) rather than failing the whole route. ----
const roadDb = makeSubDb(
  'Б-р авто',
  Object.values(T),
  [
    ['kyiv', 'warsaw'],
    ['lviv', 'berlin'],
    ['warsaw', 'vienna'],
    ['krakow', 'lviv'],
    ['vilnius', 'warsaw'],
    ['lviv', 'ternopil'],
  ]
);
const roadGroup = makeGroup('авто', [roadDb]);

// ---- Rail-station lookup ("Б.д. жд станцій з П1 до П1/1") - a dedicated
// station registry, distinct from the freight-route DB above: it only tells
// you *where* stations are, not whether a confirmed freight service runs
// between them. Used purely for the coordinate nearest-neighbour search. ----
const railStationsDb = makeSubDb('Б.д. жд станцій', railGroup.allTerminals(), []);

module.exports = {
  T,
  seaGroup,
  railGroup,
  airGroup,
  roadGroup,
  railStationsDb,
};
