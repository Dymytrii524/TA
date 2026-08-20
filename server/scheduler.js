'use strict';
/**
 * Background refresh loop: "cron-style refresh jobs, not on-request
 * fetching. Requests hit cache only" - with one honest caveat documented
 * in README/SOURCES.md: the very first request for a never-seen
 * lat/lon necessarily seeds the cache on-request (there is no way to
 * pre-warm a location nobody has asked about yet). Every request after
 * that is served from cache, and this loop keeps it warm in the
 * background so users don't pay the upstream latency.
 *
 * New connectors register themselves in REFRESHERS by sourceId instead of
 * this file growing a new branch per source - this is the "drop in without
 * refactoring" seam requested for later phases.
 */

var cache = require('./cache');
var config = require('./config');
var log = require('./log');
var openMeteoRoad = require('./connectors/openMeteoRoad');
var dpsuBorders = require('./connectors/dpsuBorders');
var granicaBorders = require('./connectors/granicaBorders');
var meteoAlarmAlerts = require('./connectors/meteoAlarmAlerts');
var aviationWeatherAir = require('./connectors/aviationWeatherAir');

var REFRESHERS = {
  openMeteoRoad: function (params) {
    return openMeteoRoad.fetchRoadWeather(params);
  },
  dpsuBorders: function () {
    return dpsuBorders.fetchDpsuBorders();
  },
  granicaBorders: function () {
    return granicaBorders.fetchGranicaBorders();
  },
  meteoAlarmAlerts: function (params) {
    return meteoAlarmAlerts.fetchAlerts(params.country);
  },
  aviationWeatherAir: function (params) {
    return aviationWeatherAir.fetchAirWeather(params);
  },
};

async function refreshKey(key) {
  var entry = cache.get(key);
  if (!entry || !entry.meta) return;
  var refresh = REFRESHERS[entry.meta.sourceId];
  if (!refresh) return;

  var started = Date.now();
  try {
    var data = await refresh(entry.meta.params);
    cache.set(key, data, entry.ttlMs, entry.meta);
    log.info(entry.meta.sourceId, 'background refresh ok', { key: key, ms: Date.now() - started });
  } catch (err) {
    cache.recordError(key, err.message);
    log.error(entry.meta.sourceId, 'background refresh failed, serving stale', { key: key, error: err.message });
  }
}

function tick() {
  cache.allKeys().forEach(function (key) {
    if (cache.isStale(key)) refreshKey(key);
  });
}

var timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, config.schedulerIntervalMs);
  log.info('scheduler', 'started', { intervalMs: config.schedulerIntervalMs });
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start: start, stop: stop, REFRESHERS: REFRESHERS };
