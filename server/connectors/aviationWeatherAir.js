'use strict';
/**
 * Connector for AviationWeather.gov Data API - METAR (current conditions)
 * and TAF (forecast) for a single airport, addressed by ICAO code (this
 * API is station-based, not lat/lon-based, unlike Open-Meteo).
 *
 * A missing METAR for a requested station is a normal, expected outcome
 * (the API replies HTTP 204, confirmed live) - e.g. Ukrainian airports
 * currently report nothing, most plausibly because Ukrainian civil
 * airspace has been closed since the start of the full-scale invasion.
 * That is surfaced as payload.metar = null, not as a connector error -
 * "this station has no current data" is not the same failure mode as
 * "the API is down", and treating it as an error would make the cache's
 * serve-stale-on-error path (meant for real outages) fire on completely
 * ordinary requests.
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

async function getJson(url) {
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs);
  var res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': config.userAgent, Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    throw new ConnectorError('AviationWeather request failed: ' + err.message, err);
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 204) return []; // documented-by-observation "no current data" response
  if (!res.ok) throw new ConnectorError('AviationWeather responded with HTTP ' + res.status + ' for ' + url);
  try {
    return await res.json();
  } catch (err) {
    throw new ConnectorError('AviationWeather returned invalid JSON for ' + url, err);
  }
}

/**
 * @param {{icao:string, locationLabel:string}} params
 * @returns {Promise<object>} a WeatherPoint (transportMode: 'air')
 */
async function fetchAirWeather(params) {
  var icao = String(params.icao || '').toUpperCase();
  if (!icao) throw new ConnectorError('fetchAirWeather requires an ICAO code');

  var metarList = await getJson('https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=json');
  var tafList = await getJson('https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=json');

  var m = metarList[0] || null;
  var tf = tafList[0] || null;

  var metar = m && {
    raw: m.rawOb,
    tempC: m.temp != null ? m.temp : null,
    windKt: m.wspd != null ? m.wspd : null,
    windDir: m.wdir != null ? m.wdir : null,
    visibility: m.visib != null ? String(m.visib) : null,
    flightCategory: m.fltCat || null, // VFR | MVFR | IFR | LIFR, computed by AviationWeather itself
    obsTime: m.reportTime || null,
  };

  var taf = tf && {
    raw: tf.rawTAF,
    issueTime: tf.issueTime || null,
    validFrom: tf.validTimeFrom ? new Date(tf.validTimeFrom * 1000).toISOString() : null,
    validTo: tf.validTimeTo ? new Date(tf.validTimeTo * 1000).toISOString() : null,
  };

  return normalizer.makeWeatherPoint({
    location: params.locationLabel,
    lat: m ? m.lat : null,
    lon: m ? m.lon : null,
    transportMode: 'air',
    sourceName: 'AviationWeather.gov',
    sourceUrl: 'https://aviationweather.gov/data/api/',
    isRealtime: true,
    payload: { icao: icao, metar: metar, taf: taf },
  });
}

module.exports = { fetchAirWeather: fetchAirWeather, ConnectorError: ConnectorError };
