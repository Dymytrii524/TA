'use strict';
/**
 * Connector for DPSU's (Ukrainian State Border Guard Service) interactive
 * map at https://dpsu.gov.ua/en/map.
 *
 * There is no JSON/XHR API behind this map - live-inspecting the page
 * (fetched HTML + map.js) showed the data is server-rendered directly into
 * a hidden <select id="by_name"> as one <option data-*> per checkpoint,
 * which map.js reads client-side to place Leaflet markers. That's actually
 * easier and more stable to parse than a DOM-rendered map would have been:
 * one HTML fetch, then a straightforward attribute extraction - no headless
 * browser needed.
 *
 * Observed fields per <option>: data-country, data-created_at,
 * data-category, data-color (grey/green/blue/red), data-character,
 * data-location, data-camera, data-longitute, data-latitute (note the
 * source's own typos - not "longitude/latitude"), data-type_text,
 * data-type (car/train/plane/anchor/ferry/marine/person, occasionally a
 * JSON-array string for checkpoints with multiple types), data-state_of_busy
 * (free-text HTML with queue counts), data-video_out, data-state
 * (відкритий/закритий), plus a plain value="..." and the option's inner text.
 */

var config = require('../config');
var normalizer = require('../normalizer/borderCrossing');

function ConnectorError(message, cause) {
  Error.call(this, message);
  this.name = 'ConnectorError';
  this.message = message;
  this.cause = cause;
}
ConnectorError.prototype = Object.create(Error.prototype);

var COUNTRY_ISO = {
  belorussia: 'BY', hungary: 'HU', moldova: 'MD', poland: 'PL',
  romania: 'RO', russia: 'RU', slovakia: 'SK',
  // These two aren't "border with a foreign country" - DPSU uses them for
  // checkpoints located inside Ukraine's own territory (international
  // airports, seaports, and, for "crimea", the administrative line with
  // the temporarily occupied territory). Kept as UA rather than invented
  // ISO codes for a non-country.
  ukraina: 'UA', crimea: 'UA',
};

var TYPE_MODE = { car: 'road', train: 'rail', plane: 'air', anchor: 'sea', ferry: 'sea', marine: 'sea', person: 'pedestrian' };

/**
 * DPSU's own CMS double-escapes quotes in some free-text fields (institution
 * names in particular come through as literal "&amp;quot;" rather than
 * "&quot;"), confirmed against live data (e.g. a Nibulon terminal entry).
 * &amp; is unescaped first so the nested entity underneath becomes decodable,
 * then the usual named entities are resolved.
 */
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveVehicleType(rawType) {
  if (!rawType) return 'unknown';
  if (rawType.charAt(0) === '[') {
    // e.g. "[&quot;car&quot;,&quot;person&quot;]" - a checkpoint that serves
    // more than one mode. We only have one vehicleType slot per normalized
    // record, so prefer whichever mode is actually freight-relevant.
    var decoded = rawType.replace(/&quot;/g, '"');
    var list;
    try { list = JSON.parse(decoded); } catch (e) { return 'unknown'; }
    for (var i = 0; i < list.length; i++) {
      if (TYPE_MODE[list[i]] && TYPE_MODE[list[i]] !== 'pedestrian') return TYPE_MODE[list[i]];
    }
    return TYPE_MODE[list[0]] || 'unknown';
  }
  return TYPE_MODE[rawType] || 'unknown';
}

/** Parses every `<option data-country="...">...</option>` block out of the
 * DPSU map page HTML. Deliberately not using a full HTML parser (no
 * dependency on cheerio/etc, matching this project's zero-npm-install
 * convention) - safe here because the attribute values are HTML-entity
 * escaped by the source (confirmed: embedded quotes appear as &quot;, not
 * raw "), so a `"([^"]*)"` capture can't be broken out of by attacker- or
 * source-controlled content. */
function parseOptions(html) {
  var chunks = html.split('<option').slice(1);
  var out = [];
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i];
    var endIdx = chunk.indexOf('</option>');
    if (endIdx === -1) continue;
    var body = chunk.slice(0, endIdx);
    if (body.indexOf('data-country') === -1) continue; // skip the plain "All" option

    var attrs = {};
    var attrRe = /data-([a-zA-Z_]+)="([^"]*)"/g;
    var m;
    while ((m = attrRe.exec(body))) attrs[m[1]] = m[2];

    // NOTE: data-state_of_busy legitimately contains raw, unescaped <br>
    // tags (unlike every other attribute, which HTML-escapes embedded
    // punctuation) - so a naive body.indexOf('>') to find where the
    // option's opening tag ends would stop inside that attribute's value
    // instead of at the real tag close. value="..." is reliably the last
    // attribute before the tag closes, so anchor the search after it.
    var valueMatch = body.match(/(?:^|\s)value="([^"]*)"/);
    var innerText = '';
    if (valueMatch) {
      var afterValue = body.slice(valueMatch.index + valueMatch[0].length);
      var closeIdx = afterValue.indexOf('>');
      if (closeIdx > -1) innerText = afterValue.slice(closeIdx + 1).trim();
    }

    out.push({
      country: attrs.country || '',
      countryIso: COUNTRY_ISO[attrs.country] || null,
      createdAt: attrs.created_at || null,
      category: decodeHtmlEntities(attrs.category),
      color: attrs.color || '',
      character: decodeHtmlEntities(attrs.character),
      location: decodeHtmlEntities(attrs.location),
      lon: (attrs.longitute || '').trim(),
      lat: (attrs.latitute || '').trim(),
      vehicleType: resolveVehicleType(attrs.type || ''),
      stateOfBusy: attrs.state_of_busy || '',
      state: attrs.state || '',
      value: decodeHtmlEntities(valueMatch ? valueMatch[1] : ''),
      innerText: decodeHtmlEntities(innerText),
    });
  }
  return out;
}

async function fetchDpsuBorders() {
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs);
  var res;
  try {
    res = await fetch('https://dpsu.gov.ua/en/map', {
      headers: { 'User-Agent': config.userAgent, Accept: 'text/html' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new ConnectorError('DPSU map request failed: ' + err.message, err);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new ConnectorError('DPSU map responded with HTTP ' + res.status);

  var html = await res.text();
  var records = parseOptions(html);
  if (records.length === 0) {
    // The page loaded but our selector found nothing - the site's markup
    // likely changed. Fail loudly in logs rather than silently returning
    // an empty (and misleadingly "no checkpoints" looking) result.
    throw new ConnectorError('DPSU map page parsed to 0 checkpoints - the page structure may have changed (expected <option data-country> entries)');
  }

  var fetchedAt = new Date().toISOString();
  return records.map(function (r) { return normalizer.makeBorderCrossingFromDpsu(r, { fetchedAt: fetchedAt }); });
}

module.exports = { fetchDpsuBorders: fetchDpsuBorders, parseOptions: parseOptions, resolveVehicleType: resolveVehicleType, ConnectorError: ConnectorError };
