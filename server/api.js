'use strict';
/**
 * Internal REST API. Deliberately built on Node's built-in `http` module,
 * not Express - this project has no package.json/npm workflow yet (see
 * SOURCES.md / the plan agreed with the user), so this stays runnable with
 * zero `npm install`. Swapping in Express later is a contained change: only
 * this file and index.js would need to move.
 *
 * Routes:
 *   GET  /api/services/weather?mode=road&lat=&lon=&label=
 *   GET  /api/services/directory?transport=&region=&q=
 *   GET  /api/services/borders?country=&vehicle_type=
 *   GET  /api/qa/wiki?category=&q=
 *   GET  /api/qa/outputs?tag=&q=
 *   POST /api/qa/ask  { question }
 *   GET  /api/health
 */

var http = require('http');
var url = require('url');
var fs = require('fs');
var path = require('path');
var cache = require('./cache');
var config = require('./config');
var log = require('./log');
var openMeteoRoad = require('./connectors/openMeteoRoad');
var dpsuBorders = require('./connectors/dpsuBorders');
var granicaBorders = require('./connectors/granicaBorders');
var meteoAlarmAlerts = require('./connectors/meteoAlarmAlerts');
var aviationWeatherAir = require('./connectors/aviationWeatherAir');
var anthropicChat = require('./connectors/anthropicChat');
var qaRetrieval = require('./services/qaRetrieval');

/**
 * The directory is curated static data (see SOURCES.md), not something
 * fetched from an external source at request time, so unlike the weather
 * connector it doesn't go through cache/scheduler/TTL - there is no
 * upstream latency or rate limit to hide from. It's still served only
 * through /api/services/*, same as everything else, and normalized the
 * same way, so the frontend never has to special-case it.
 */
var directoryData = null;
function loadDirectory() {
  if (directoryData) return directoryData;
  var raw = fs.readFileSync(path.join(__dirname, 'data/directory.json'), 'utf8');
  directoryData = JSON.parse(raw);
  return directoryData;
}

function handleDirectory(req, res, query) {
  var entries;
  try {
    entries = loadDirectory();
  } catch (err) {
    log.error('directory', 'failed to load directory.json', { error: err.message });
    sendJson(res, 500, { error: 'internal_error', message_uk: 'Не вдалося завантажити довідник.' });
    return;
  }

  var transport = (query.transport || '').trim();
  var region = (query.region || '').trim();
  var q = (query.q || '').trim().toLowerCase();

  var filtered = entries.filter(function (e) {
    if (transport && e.transport.indexOf(transport) === -1) return false;
    if (region && e.region !== region) return false;
    if (q && e.name_uk.toLowerCase().indexOf(q) === -1 && e.description_uk.toLowerCase().indexOf(q) === -1) return false;
    return true;
  });

  sendJson(res, 200, { count: filtered.length, entries: filtered });
}

/**
 * Wiki (curated knowledge-base articles) and Outputs (finished checklists
 * built from those articles) - same "curated static data" reasoning as
 * loadDirectory above: no upstream, no TTL, loaded once and cached in
 * module state.
 */
var wikiData = null;
function loadWiki() {
  if (wikiData) return wikiData;
  var raw = fs.readFileSync(path.join(__dirname, 'data/wiki.json'), 'utf8');
  wikiData = JSON.parse(raw);
  return wikiData;
}

var outputsData = null;
function loadOutputs() {
  if (outputsData) return outputsData;
  var raw = fs.readFileSync(path.join(__dirname, 'data/outputs.json'), 'utf8');
  outputsData = JSON.parse(raw);
  return outputsData;
}

function handleQaWiki(req, res, query) {
  var items;
  try {
    items = loadWiki();
  } catch (err) {
    log.error('qa', 'failed to load wiki.json', { error: err.message });
    sendJson(res, 500, { error: 'internal_error', message_uk: 'Не вдалося завантажити базу знань.' });
    return;
  }

  var category = (query.category || '').trim();
  var q = (query.q || '').trim().toLowerCase();

  var filtered = items.filter(function (a) {
    if (a.status !== 'published') return false;
    if (category && a.category !== category) return false;
    if (q) {
      var haystack = (a.title + ' ' + a.summary + ' ' + a.tags.join(' ')).toLowerCase();
      if (haystack.indexOf(q) === -1) return false;
    }
    return true;
  });

  sendJson(res, 200, { count: filtered.length, entries: filtered });
}

function handleQaOutputs(req, res, query) {
  var items;
  try {
    items = loadOutputs();
  } catch (err) {
    log.error('qa', 'failed to load outputs.json', { error: err.message });
    sendJson(res, 500, { error: 'internal_error', message_uk: 'Не вдалося завантажити бібліотеку матеріалів.' });
    return;
  }

  var tag = (query.tag || '').trim().toLowerCase();
  var q = (query.q || '').trim().toLowerCase();

  var filtered = items.filter(function (o) {
    if (o.status !== 'published') return false;
    if (tag && o.tags.map(function (x) { return x.toLowerCase(); }).indexOf(tag) === -1) return false;
    if (q) {
      var haystack = (o.title + ' ' + o.summary + ' ' + o.tags.join(' ')).toLowerCase();
      if (haystack.indexOf(q) === -1) return false;
    }
    return true;
  });

  sendJson(res, 200, { count: filtered.length, entries: filtered });
}

function toSourceRef(r) {
  return { kind: r.kind, id: r.item.id, title: r.item.title };
}

var QA_SYSTEM_PROMPT_PREFIX =
  'Ти - асистент бази знань логістичної платформи Trans-Atlas (міжнародні вантажоперевезення). ' +
  'Відповідай ТІЛЬКИ на основі матеріалів нижче, позначених [1], [2] тощо, і посилайся на їхні номери у відповіді. ' +
  'Якщо наданих матеріалів недостатньо для впевненої відповіді - прямо напиши про це і не вигадуй факти, цифри чи джерела, ' +
  'яких немає серед матеріалів. Відповідай українською мовою, стисло (до 120 слів).\n\nМатеріали:\n';

async function handleQaAsk(req, res, body) {
  var question = String((body && body.question) || '').trim();
  if (!question) {
    sendJson(res, 400, { error: 'bad_request', message_uk: 'Питання не може бути порожнім.' });
    return;
  }
  if (question.length > 500) {
    sendJson(res, 400, { error: 'bad_request', message_uk: 'Питання завелике (максимум 500 символів).' });
    return;
  }

  var wiki, outputs;
  try {
    wiki = loadWiki();
    outputs = loadOutputs();
  } catch (err) {
    log.error('qa', 'failed to load knowledge base', { error: err.message });
    sendJson(res, 500, { error: 'internal_error', message_uk: 'Не вдалося завантажити базу знань.' });
    return;
  }

  var results = qaRetrieval.search(question, wiki, outputs);
  if (!results.length) {
    sendJson(res, 200, {
      answer: null,
      insufficient: true,
      message_uk: 'У базі знань поки немає матеріалів, які відповідають на це питання. Спробуйте переформулювати або скористайтеся формою нижче.',
      sources: [],
    });
    return;
  }

  var top = results.slice(0, 4);
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    sendJson(res, 200, {
      answer: null,
      aiUnavailable: true,
      message_uk: 'AI-відповіді ще не підключені на сервері (не задано ANTHROPIC_API_KEY). Ось матеріали з бази знань, які стосуються питання:',
      sources: top.map(toSourceRef),
    });
    return;
  }

  var context = top.map(function (r, i) {
    var body_ = r.item.body || (r.item.items || []).join('; ');
    return '[' + (i + 1) + '] (' + r.kind + ') ' + r.item.title + '\n' + (r.item.summary ? r.item.summary + '\n' : '') + body_;
  }).join('\n\n');

  try {
    var result = await anthropicChat.askClaude({
      apiKey: apiKey,
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      system: QA_SYSTEM_PROMPT_PREFIX + context,
      question: question,
    });
    log.info('qa', 'answered', { question: question, topScore: top[0].score, model: result.model });
    sendJson(res, 200, {
      answer: result.text,
      insufficient: false,
      confidence: top[0].score >= 6 ? 'high' : (top[0].score >= 3 ? 'medium' : 'low'),
      sources: top.map(toSourceRef),
      model: result.model,
    });
  } catch (err) {
    log.error('qa', 'anthropic call failed', { error: err.message });
    sendJson(res, 502, {
      error: 'upstream_unavailable',
      message_uk: 'Не вдалося отримати відповідь від AI. Спробуйте пізніше.',
      sources: top.map(toSourceRef),
    });
  }
}

/** Reads and JSON-parses a request body, capped at 8KB - these are short
 * chat questions, not file uploads, so a generous-but-bounded cap is enough
 * to stop an accidental (or malicious) huge body from being buffered fully
 * into memory. */
function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    var limit = 8 * 1024;
    req.on('data', function (chunk) {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (!chunks.length) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  var text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // Read-only, unauthenticated public weather data served to a local dev
    // frontend that may be opened from file:// or GitHub Pages - CORS is
    // safe to leave open here. Revisit if this API ever serves anything
    // account-specific.
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

function roundCoord(n) {
  return Math.round(n * 100) / 100; // ~1.1km grid - enough to reuse cache across nearby requests
}

async function handleWeather(req, res, query) {
  var mode = query.mode || 'road';
  if (mode === 'road') return handleWeatherRoad(req, res, query);
  if (mode === 'air') return handleWeatherAir(req, res, query);
  sendJson(res, 501, {
    error: 'not_implemented',
    message_uk: 'Модуль погоди для цього виду транспорту ще не підключено в цій фазі.',
    mode: mode,
  });
}

/** MeteoAlarm alerts are fetched/cached independently of the Open-Meteo
 * forecast they get attached to (own 10-min TTL vs the forecast's 30 min),
 * and merged into the response at request time rather than baked into the
 * cached WeatherPoint - that way the two refresh on their own real
 * schedules instead of the faster-changing one being held hostage by the
 * slower one's cache key. A country MeteoAlarm fails for, or doesn't
 * cover, degrades to "no alerts shown" rather than breaking the weather
 * request that asked for them - overlay is an enhancement, not a
 * dependency the whole feature should go down with. */
async function getAlertsForCountry(country) {
  if (!country) return [];
  var key = 'alerts:meteoalarm:' + country;
  var entry = cache.get(key);
  if (entry && entry.ok && entry.data) {
    if (cache.isStale(key)) refreshAlerts(key, country).catch(function () {});
    return entry.data;
  }
  try {
    return await refreshAlerts(key, country);
  } catch (err) {
    return [];
  }
}

async function refreshAlerts(key, country) {
  var ttlMs = config.sources.meteoAlarm.ttlMs;
  try {
    var data = await meteoAlarmAlerts.fetchAlerts(country);
    cache.set(key, data, ttlMs, { sourceId: 'meteoAlarmAlerts', params: { country: country } });
    log.info('meteoAlarmAlerts', 'fetched ok', { country: country, count: data.length });
    return data;
  } catch (err) {
    cache.recordError(key, err.message);
    log.error('meteoAlarmAlerts', 'fetch failed', { country: country, error: err.message });
    throw err;
  }
}

async function handleWeatherRoad(req, res, query) {
  var lat = parseFloat(query.lat);
  var lon = parseFloat(query.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    sendJson(res, 400, { error: 'bad_request', message_uk: 'Потрібні коректні параметри lat і lon.' });
    return;
  }
  lat = roundCoord(lat);
  lon = roundCoord(lon);
  var label = query.label || (lat + ',' + lon);
  var country = (query.country || '').trim().toUpperCase();
  var key = 'weather:road:' + lat + ':' + lon;

  var weatherData, stale, lastError;
  var entry = cache.get(key);
  if (entry && entry.ok && entry.data) {
    weatherData = entry.data;
    stale = cache.isStale(key);
    lastError = entry.lastError || null;
    // Warm it in the background if stale, so the *next* caller gets fresh data
    // without paying the latency - this keeps requests "cache only" once warm.
    if (stale) refreshAndCache(key, { lat: lat, lon: lon, locationLabel: label });
  } else {
    // True cache miss (never fetched before) - only case where a request
    // blocks on the upstream, since there's nothing to pre-warm for a
    // location nobody has asked about yet.
    try {
      weatherData = await refreshAndCache(key, { lat: lat, lon: lon, locationLabel: label });
      stale = false; lastError = null;
    } catch (err) {
      sendJson(res, 502, {
        error: 'upstream_unavailable',
        message_uk: 'Не вдалося отримати дані про погоду. Спробуйте пізніше.',
        detail: err.message,
      });
      return;
    }
  }

  var alerts = await getAlertsForCountry(country);
  var responseData = Object.assign({}, weatherData, { alerts: alerts });
  sendJson(res, 200, { stale: stale, last_error: lastError, data: responseData });
}

async function refreshAndCache(key, params) {
  var ttlMs = config.sources.openMeteo.ttlMs;
  try {
    var data = await openMeteoRoad.fetchRoadWeather(params);
    cache.set(key, data, ttlMs, { sourceId: 'openMeteoRoad', params: params });
    log.info('openMeteoRoad', 'fetched ok', { key: key });
    return data;
  } catch (err) {
    cache.recordError(key, err.message);
    log.error('openMeteoRoad', 'fetch failed', { key: key, error: err.message });
    throw err;
  }
}

async function handleWeatherAir(req, res, query) {
  var icao = String(query.icao || '').trim().toUpperCase();
  if (!icao) {
    sendJson(res, 400, { error: 'bad_request', message_uk: 'Потрібен параметр icao.' });
    return;
  }
  var label = query.label || icao;
  var key = 'weather:air:' + icao;

  var entry = cache.get(key);
  if (entry && entry.ok && entry.data) {
    sendJson(res, 200, { stale: cache.isStale(key), last_error: entry.lastError || null, data: entry.data });
    if (cache.isStale(key)) refreshAirAndCache(key, { icao: icao, locationLabel: label });
    return;
  }

  try {
    var data = await refreshAirAndCache(key, { icao: icao, locationLabel: label });
    sendJson(res, 200, { stale: false, last_error: null, data: data });
  } catch (err) {
    sendJson(res, 502, {
      error: 'upstream_unavailable',
      message_uk: 'Не вдалося отримати авіаційні дані. Спробуйте пізніше.',
      detail: err.message,
    });
  }
}

async function refreshAirAndCache(key, params) {
  var ttlMs = config.sources.aviationWeather.ttlMs;
  try {
    var data = await aviationWeatherAir.fetchAirWeather(params);
    cache.set(key, data, ttlMs, { sourceId: 'aviationWeatherAir', params: params });
    log.info('aviationWeatherAir', 'fetched ok', { key: key });
    return data;
  } catch (err) {
    cache.recordError(key, err.message);
    log.error('aviationWeatherAir', 'fetch failed', { key: key, error: err.message });
    throw err;
  }
}

/**
 * Unlike weather (cached per lat/lon), DPSU's page returns ALL ~250
 * checkpoints in one fetch, so there's exactly one cache key for the
 * whole dataset - filtering by country/vehicle_type happens in-memory
 * per request against the cached list, not as separate upstream calls.
 */
var BORDERS_SOURCES = [
  { key: 'borders:dpsu', sourceId: 'dpsuBorders', ttlSource: 'dpsu', fetch: dpsuBorders.fetchDpsuBorders },
  { key: 'borders:granica', sourceId: 'granicaBorders', ttlSource: 'granicaGovPl', fetch: granicaBorders.fetchGranicaBorders },
];

async function refreshBorderSource(src) {
  var ttlMs = config.sources[src.ttlSource].ttlMs;
  try {
    var data = await src.fetch();
    cache.set(src.key, data, ttlMs, { sourceId: src.sourceId, params: {} });
    log.info(src.sourceId, 'fetched ok', { count: data.length });
    return data;
  } catch (err) {
    cache.recordError(src.key, err.message);
    log.error(src.sourceId, 'fetch failed', { error: err.message });
    throw err;
  }
}

/** Pulls each configured border source from cache (fetching once if never
 * seen, warming stale entries in the background otherwise), and returns
 * whatever combination of sources actually succeeded - one government
 * source having a bad day doesn't take the other one down with it. */
async function handleBorders(req, res, query) {
  var combined = [];
  var anyOk = false;
  var anyStale = false;
  var errors = [];

  for (var i = 0; i < BORDERS_SOURCES.length; i++) {
    var src = BORDERS_SOURCES[i];
    var entry = cache.get(src.key);
    if (entry && entry.ok && entry.data) {
      combined = combined.concat(entry.data);
      anyOk = true;
      if (cache.isStale(src.key)) { anyStale = true; refreshBorderSource(src); }
    } else {
      try {
        var data = await refreshBorderSource(src);
        combined = combined.concat(data);
        anyOk = true;
      } catch (err) {
        errors.push({ source: src.sourceId, message: err.message });
      }
    }
  }

  if (!anyOk) {
    sendJson(res, 502, {
      error: 'upstream_unavailable',
      message_uk: 'Не вдалося отримати дані про кордони з жодного джерела. Спробуйте пізніше.',
      errors: errors,
    });
    return;
  }

  var country = (query.country || '').trim().toUpperCase();
  var vehicleType = (query.vehicle_type || '').trim();
  var filtered = combined.filter(function (c) {
    if (country && c.countryPair.to !== country) return false;
    if (vehicleType && c.vehicleType !== vehicleType) return false;
    return true;
  });

  sendJson(res, 200, {
    stale: anyStale,
    partial: errors.length > 0,
    errors: errors,
    count: filtered.length,
    entries: filtered,
  });
}

function handleHealth(req, res) {
  var keys = cache.allKeys();
  var perSource = {};
  keys.forEach(function (key) {
    var entry = cache.get(key);
    var sourceId = (entry && entry.meta && entry.meta.sourceId) || 'unknown';
    if (!perSource[sourceId]) perSource[sourceId] = { keys: 0, last_success: null, last_error: null };
    perSource[sourceId].keys += 1;
    if (entry.ok && entry.fetchedAt) {
      var ts = new Date(entry.fetchedAt).toISOString();
      if (!perSource[sourceId].last_success || ts > perSource[sourceId].last_success) {
        perSource[sourceId].last_success = ts;
      }
    }
    if (entry.lastError) perSource[sourceId].last_error = entry.lastError;
  });

  var configuredSources = {};
  Object.keys(config.sources).forEach(function (id) {
    configuredSources[id] = { status: config.sources[id].status, ttl_ms: config.sources[id].ttlMs };
  });

  sendJson(res, 200, {
    ok: true,
    now: new Date().toISOString(),
    cached_keys: keys.length,
    per_source: perSource,
    configured_sources: configuredSources,
  });
}

function createServer() {
  return http.createServer(function (req, res) {
    var parsed = url.parse(req.url, true);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        // POST /api/qa/ask sends Content-Type: application/json, which isn't
        // a CORS-safelisted content type - browsers preflight it with an
        // OPTIONS request and expect this header echoed back before they'll
        // send the real POST. Without it, fetch() fails with an opaque
        // network error (no server log, no response) - curl doesn't do
        // preflights, so this only shows up in an actual browser.
        'Access-Control-Allow-Headers': 'content-type',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/qa/ask') {
      readJsonBody(req).then(function (body) {
        return handleQaAsk(req, res, body);
      }).catch(function (err) {
        log.error('api', 'bad POST /api/qa/ask body', { error: err.message });
        sendJson(res, 400, { error: 'bad_request', message_uk: 'Некоректне тіло запиту.' });
      });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (parsed.pathname === '/api/qa/wiki') {
      handleQaWiki(req, res, parsed.query);
      return;
    }
    if (parsed.pathname === '/api/qa/outputs') {
      handleQaOutputs(req, res, parsed.query);
      return;
    }
    if (parsed.pathname === '/api/services/weather') {
      handleWeather(req, res, parsed.query).catch(function (err) {
        log.error('api', 'unhandled error in /api/services/weather', { error: err.message });
        sendJson(res, 500, { error: 'internal_error' });
      });
      return;
    }
    if (parsed.pathname === '/api/services/directory') {
      handleDirectory(req, res, parsed.query);
      return;
    }
    if (parsed.pathname === '/api/services/borders') {
      handleBorders(req, res, parsed.query).catch(function (err) {
        log.error('api', 'unhandled error in /api/services/borders', { error: err.message });
        sendJson(res, 500, { error: 'internal_error' });
      });
      return;
    }
    if (parsed.pathname === '/api/health') {
      handleHealth(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
}

module.exports = { createServer: createServer };
