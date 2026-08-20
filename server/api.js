'use strict';
/**
 * Internal REST API. Deliberately built on Node's built-in `http` module,
 * not Express - this project has no package.json/npm workflow yet (see
 * SOURCES.md / the plan agreed with the user), so this stays runnable with
 * zero `npm install`. Swapping in Express later is a contained change: only
 * this file and index.js would need to move.
 *
 * Routes:
 *   GET /api/services/weather?mode=road&lat=&lon=&label=
 *   GET /api/services/directory?transport=&region=&q=
 *   GET /api/health
 */

var http = require('http');
var url = require('url');
var fs = require('fs');
var path = require('path');
var cache = require('./cache');
var config = require('./config');
var log = require('./log');
var openMeteoRoad = require('./connectors/openMeteoRoad');

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
  if (mode !== 'road') {
    sendJson(res, 501, {
      error: 'not_implemented',
      message_uk: 'Модуль погоди для цього виду транспорту ще не підключено в цій фазі.',
      mode: mode,
    });
    return;
  }

  var lat = parseFloat(query.lat);
  var lon = parseFloat(query.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    sendJson(res, 400, { error: 'bad_request', message_uk: 'Потрібні коректні параметри lat і lon.' });
    return;
  }
  lat = roundCoord(lat);
  lon = roundCoord(lon);
  var label = query.label || (lat + ',' + lon);
  var key = 'weather:road:' + lat + ':' + lon;

  var entry = cache.get(key);
  if (entry && entry.ok && entry.data) {
    sendJson(res, 200, {
      stale: cache.isStale(key),
      last_error: entry.lastError || null,
      data: entry.data,
    });
    // Warm it in the background if stale, so the *next* caller gets fresh data
    // without paying the latency - this keeps requests "cache only" once warm.
    if (cache.isStale(key)) refreshAndCache(key, { lat: lat, lon: lon, locationLabel: label });
    return;
  }

  // True cache miss (never fetched before) - only case where a request
  // blocks on the upstream, since there's nothing to pre-warm for a
  // location nobody has asked about yet.
  try {
    var data = await refreshAndCache(key, { lat: lat, lon: lon, locationLabel: label });
    sendJson(res, 200, { stale: false, last_error: null, data: data });
  } catch (err) {
    sendJson(res, 502, {
      error: 'upstream_unavailable',
      message_uk: 'Не вдалося отримати дані про погоду. Спробуйте пізніше.',
      detail: err.message,
    });
  }
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
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
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
    if (parsed.pathname === '/api/health') {
      handleHealth(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
}

module.exports = { createServer: createServer };
