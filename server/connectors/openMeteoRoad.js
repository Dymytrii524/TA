'use strict';
/**
 * Connector for Open-Meteo -> road-transport weather.
 *
 * Contract every connector in this project must follow:
 *   - exports a single async fetch(params) function
 *   - never throws to its caller for "the upstream had a bad day" reasons;
 *     it throws a typed ConnectorError so the cache layer can decide to
 *     serve stale data instead of crashing the request
 *   - returns data already shaped by normalizer/weatherPoint.js
 *   - reads nothing from process.env directly for source URLs (config.js
 *     owns that), so the base URL is swappable without touching this file
 */

var config = require('../config');
var normalizer = require('../normalizer/weatherPoint');

function ConnectorError(message, cause) {
  Error.call(this, message);
  this.name = 'ConnectorError';
  this.message = message;
  this.cause = cause;
}
ConnectorError.prototype = Object.create(Error.prototype);

var WEATHER_CODE_UK = {
  0: 'Ясно', 1: 'Переважно ясно', 2: 'Мінлива хмарність', 3: 'Хмарно',
  45: 'Туман', 48: 'Паморозевий туман',
  51: 'Легка мряка', 53: 'Помірна мряка', 55: 'Сильна мряка',
  61: 'Невеликий дощ', 63: 'Помірний дощ', 65: 'Сильний дощ',
  71: 'Невеликий сніг', 73: 'Помірний сніг', 75: 'Сильний сніг',
  80: 'Зливи', 81: 'Сильні зливи', 82: 'Дуже сильні зливи',
  95: 'Гроза', 96: 'Гроза з градом', 99: 'Сильна гроза з градом',
};

function describeWeatherCode(code) {
  return WEATHER_CODE_UK[code] || ('Погодні умови (код ' + code + ')');
}

/** Turns Open-Meteo's parallel-array hourly response into the flat
 * per-hour records the normalizer's risk estimator expects. */
function parseHourly(hourly, fromIndex, count) {
  var out = [];
  for (var i = fromIndex; i < Math.min(fromIndex + count, hourly.time.length); i++) {
    out.push({
      time: hourly.time[i],
      temperatureC: hourly.temperature_2m[i],
      precipitationMm: hourly.precipitation[i],
      windSpeedKmh: hourly.wind_speed_10m[i],
      weatherCode: hourly.weather_code[i],
      conditionUk: describeWeatherCode(hourly.weather_code[i]),
    });
  }
  return out;
}

/**
 * @param {{lat:number, lon:number, locationLabel:string}} params
 * @returns {Promise<object>} a WeatherPoint (see normalizer/weatherPoint.js)
 */
async function fetchRoadWeather(params) {
  var url = new URL(config.sources.openMeteo.baseUrl);
  url.searchParams.set('latitude', params.lat);
  url.searchParams.set('longitude', params.lon);
  url.searchParams.set('hourly', 'temperature_2m,precipitation,wind_speed_10m,weather_code');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('timezone', 'auto');

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs);

  var res;
  try {
    res = await fetch(url.toString(), {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new ConnectorError('Open-Meteo request failed: ' + err.message, err);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new ConnectorError('Open-Meteo responded with HTTP ' + res.status);
  }

  var json;
  try {
    json = await res.json();
  } catch (err) {
    throw new ConnectorError('Open-Meteo returned invalid JSON', err);
  }

  if (!json.hourly || !Array.isArray(json.hourly.time)) {
    // The upstream schema changed under us - fail loudly in logs, soft to the caller.
    throw new ConnectorError('Open-Meteo response is missing the expected "hourly" arrays (schema may have changed)');
  }

  // Find the hourly index closest to "now" in the location's own timezone,
  // so "current" isn't accidentally yesterday's first entry.
  var nowIso = new Date().toISOString().slice(0, 13);
  var nowIdx = json.hourly.time.findIndex(function (t) { return t.slice(0, 13) >= nowIso; });
  if (nowIdx === -1) nowIdx = 0;

  var next12h = parseHourly(json.hourly, nowIdx, 12);
  var current = next12h[0] || null;

  return normalizer.makeWeatherPoint({
    location: params.locationLabel,
    lat: params.lat,
    lon: params.lon,
    transportMode: 'road',
    sourceName: config.sources.openMeteo.name,
    sourceUrl: 'https://open-meteo.com/',
    isRealtime: true,
    payload: {
      current: current,
      next12h: next12h,
      road_risk: normalizer.estimateRoadRisk(next12h),
    },
  });
}

module.exports = {
  fetchRoadWeather: fetchRoadWeather,
  ConnectorError: ConnectorError,
  describeWeatherCode: describeWeatherCode,
  parseHourly: parseHourly,
};
