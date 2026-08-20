'use strict';
/**
 * Central config for the Services aggregation backend.
 *
 * All source-specific tuning (TTL, base URL, licence note) lives here so a
 * new connector only has to add one entry, not touch cache/scheduler/api code.
 *
 * TTLs below match the values given in the Phase 1 brief. Only Open-Meteo is
 * wired up in this slice; the others are listed (not implemented) so the
 * config shape doesn't change when they're added later - see SOURCES.md.
 */

var CONTACT_URL = process.env.SERVICE_CONTACT_URL || 'https://github.com/dymytriipryl/trans-atlas';
var USER_AGENT = 'trans-atlas.net-services/0.1 (+' + CONTACT_URL + ')';

var SOURCES = {
  openMeteo: {
    name: 'Open-Meteo',
    baseUrl: 'https://api.open-meteo.com/v1/forecast',
    ttlMs: 30 * 60 * 1000, // 30 min, per brief
    licence: 'Free for non-commercial and reasonable commercial use, no key required. Attribution appreciated, not mandatory.',
    requiresKey: false,
    status: 'implemented',
  },
  dpsu: { name: 'ДПСУ (Державна прикордонна служба України)', ttlMs: 5 * 60 * 1000, licence: 'No public API, HTML/JS map - throttle + attribute.', requiresKey: false, status: 'not_implemented' },
  granicaGovPl: { name: 'granica.gov.pl (KAS)', ttlMs: 30 * 60 * 1000, licence: 'No public API, HTML table - throttle + attribute.', requiresKey: false, status: 'not_implemented' },
  meteoAlarm: { name: 'MeteoAlarm (EUMETNET)', ttlMs: 10 * 60 * 1000, licence: 'Free, attribution required.', requiresKey: false, status: 'not_implemented' },
  aviationWeather: { name: 'AviationWeather.gov', ttlMs: 60 * 1000, licence: 'Free, US government public data.', requiresKey: false, status: 'not_implemented' },
  carec: { name: 'CAREC BCP Monitor', ttlMs: 30 * 24 * 60 * 60 * 1000, licence: 'Free, reference/historical only - never label as live.', requiresKey: false, status: 'not_implemented' },
  imfPortwatch: { name: 'IMF PortWatch', ttlMs: 24 * 60 * 60 * 1000, licence: 'Free, attribution to IMF PortWatch required.', requiresKey: false, status: 'not_implemented' },
  copernicusMarine: { name: 'Copernicus Marine Service', ttlMs: 30 * 60 * 1000, licence: 'Free, EU programme, registration required.', requiresKey: true, status: 'not_implemented' },
};

module.exports = {
  port: Number(process.env.PORT) || 8787,
  userAgent: USER_AGENT,
  contactUrl: CONTACT_URL,
  requestTimeoutMs: 8000,
  cacheFile: require('path').join(__dirname, '.cache.json'),
  schedulerIntervalMs: 60 * 1000, // how often the scheduler checks which cached keys need a refresh
  sources: SOURCES,
};
