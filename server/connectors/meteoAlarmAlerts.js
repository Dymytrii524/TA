'use strict';
/**
 * Connector for MeteoAlarm (EUMETNET's official European storm-warning
 * network) - per-country Atom/CAP feeds at feeds.meteoalarm.org.
 *
 * api.meteoalarm.org itself turned out to be an interactive docs/landing
 * page, not a queryable endpoint; the actual data lives at the legacy
 * per-country Atom feeds (still officially served, CC BY 4.0-equivalent
 * per the feed's own <rights> tag - attribution required, kept in the
 * normalized record's source/sourceUrl and surfaced in the UI).
 *
 * Confirmed live: Ukraine, Poland, Germany, Austria, Netherlands,
 * Lithuania, Czechia (slug "czechia", not "czech-republic") and Romania
 * all have working feeds. Turkey does not (MeteoAlarm covers EUMETNET
 * members, not Turkey) - COUNTRY_SLUGS simply omits it, and a country
 * with no slug just gets an empty alerts list rather than an error.
 */

var config = require('../config');

function ConnectorError(message, cause) {
  Error.call(this, message);
  this.name = 'ConnectorError';
  this.message = message;
  this.cause = cause;
}
ConnectorError.prototype = Object.create(Error.prototype);

var COUNTRY_SLUGS = {
  UA: 'ukraine', PL: 'poland', DE: 'germany', AT: 'austria', NL: 'netherlands',
  LT: 'lithuania', CZ: 'czechia', RO: 'romania',
};

/** MeteoAlarm's own awareness-level colour is the first word of cap:event
 * ("Yellow high-temperature warning...") - reading it directly from the
 * text is more faithful than re-deriving severity from cap:severity, which
 * uses a different (CAP-standard Minor/Moderate/Severe/Extreme) scale that
 * doesn't map 1:1 onto MeteoAlarm's yellow/orange/red awareness levels. */
function colorFromEventText(eventText) {
  var m = String(eventText || '').match(/^\s*(Yellow|Orange|Red)\b/i);
  if (!m) return 'unknown';
  var word = m[1].toLowerCase();
  if (word === 'yellow') return 'yellow';
  if (word === 'orange') return 'red'; // our UI only has 3 tiers - orange escalates to red, not folded into yellow
  if (word === 'red') return 'red';
  return 'unknown';
}

function textOf(entryXml, tag) {
  var m = entryXml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
  return m ? m[1].trim() : null;
}

function parseFeed(xml) {
  var entries = xml.split('<entry>').slice(1);
  return entries.map(function (chunk) {
    var body = chunk.slice(0, chunk.indexOf('</entry>'));
    var event = textOf(body, 'cap:event');
    return {
      event: event,
      color: colorFromEventText(event),
      areaDesc: textOf(body, 'cap:areaDesc'),
      severity: textOf(body, 'cap:severity'),
      onset: textOf(body, 'cap:onset'),
      expires: textOf(body, 'cap:expires'),
    };
  }).filter(function (e) { return e.event; });
}

/**
 * @param {string} countryIso - e.g. 'UA', 'PL'
 * @returns {Promise<object[]>} normalized alerts, or [] for a country
 *   MeteoAlarm doesn't cover (not an error - most of the world isn't in a
 *   33-country European network, that's expected, not a failure)
 */
async function fetchAlerts(countryIso) {
  var slug = COUNTRY_SLUGS[countryIso];
  if (!slug) return [];

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs);
  var res;
  try {
    // NOTE: an explicit Accept: application/atom+xml gets this endpoint to
    // reply 406 - confirmed live. curl's default Accept: */* works, so
    // that's what's sent here instead of the more "correct"-looking value.
    res = await fetch('https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-' + slug + '/', {
      headers: { 'User-Agent': config.userAgent, Accept: '*/*' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new ConnectorError('MeteoAlarm request failed for ' + countryIso + ': ' + err.message, err);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new ConnectorError('MeteoAlarm responded with HTTP ' + res.status + ' for ' + countryIso);

  var xml = await res.text();
  if (xml.indexOf('<feed') === -1) {
    throw new ConnectorError('MeteoAlarm response for ' + countryIso + ' does not look like an Atom feed - the source may have changed');
  }
  return parseFeed(xml);
}

module.exports = {
  fetchAlerts: fetchAlerts,
  parseFeed: parseFeed,
  colorFromEventText: colorFromEventText,
  COUNTRY_SLUGS: COUNTRY_SLUGS,
  ConnectorError: ConnectorError,
};
