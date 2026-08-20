'use strict';
/**
 * Normalized internal schema for weather data, per the Phase 1 spec:
 *
 *   WeatherPoint { location, lat, lon, transport_mode, payload, alerts[],
 *                  updated_at, source_name, source_url, is_realtime }
 *
 * Every connector must return data shaped by makeWeatherPoint() so the API
 * layer and the frontend never need to know which upstream source produced
 * it. `payload` is intentionally source/mode-specific (a road forecast looks
 * nothing like a METAR), but the envelope around it is always the same.
 */

function makeWeatherPoint(opts) {
  return {
    location: opts.location,
    lat: opts.lat,
    lon: opts.lon,
    transport_mode: opts.transportMode, // 'road' | 'rail' | 'sea' | 'air'
    payload: opts.payload,
    alerts: opts.alerts || [],
    updated_at: opts.updatedAt || new Date().toISOString(),
    source_name: opts.sourceName,
    source_url: opts.sourceUrl,
    is_realtime: opts.isRealtime !== false,
  };
}

/**
 * Derives an honest, clearly-labelled ROAD RISK ESTIMATE from raw forecast
 * numbers. This is NOT an official alert (MeteoAlarm is the real alert
 * source, not wired up in this slice) - callers must render it as
 * "оцінка", never as an authority-issued warning.
 */
function estimateRoadRisk(hourly) {
  var flags = [];
  if (hourly.some(function (h) { return h.temperatureC <= 1 && h.precipitationMm > 0; })) {
    flags.push({ code: 'ice_risk', label_uk: 'Ризик ожеледиці' });
  }
  if (hourly.some(function (h) { return h.windSpeedKmh >= 60; })) {
    flags.push({ code: 'high_wind', label_uk: 'Сильний вітер' });
  }
  if (hourly.some(function (h) { return h.precipitationMm >= 10; })) {
    flags.push({ code: 'heavy_rain', label_uk: 'Сильні опади' });
  }
  return flags;
}

module.exports = { makeWeatherPoint: makeWeatherPoint, estimateRoadRisk: estimateRoadRisk };
