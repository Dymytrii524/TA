'use strict';
/**
 * Connector for granica.gov.pl (Polish border/customs service, KAS) -
 * estimated wait times at Poland-Ukraine road checkpoints.
 *
 * Live-inspecting the site found:
 *  - the bare URL from the brief (index_wait.php?p) defaults to the Belarus
 *    border; the Ukraine table needs explicit query params, found by
 *    following the site's own country-picker links: ?p=u&v=pl&k=w
 *  - it's a plain server-rendered HTML table (no JS/XHR involved), laid out
 *    as one <th> header row of checkpoint names followed by one <tr> per
 *    vehicle category (identified by an <img src="images/CATEGORY.gif">),
 *    each with one <td> per checkpoint in the same left-to-right order as
 *    the headers
 *  - truck cells carry a weight-class label (">7,5T DMC" or "≤7,5T DMC")
 *    alongside the H:MM wait time; a cell with only "&nbsp;" (grey
 *    background in the source) means no data for that checkpoint
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

function cleanCell(html) {
  return html.replace(/&nbsp;/g, ' ').replace(/<br\s*\/?>/gi, ' | ').replace(/\s+/g, ' ').trim();
}

/** Header cells (checkpoint names) also contain a trailing <br/> in the
 * source markup (e.g. "Medyka&nbsp;<br/>"), which cleanCell's ' | '
 * substitution would leave as a stray "Medyka |" - names just need the
 * <br/> dropped, not turned into a separator. */
function cleanName(html) {
  return html.replace(/&nbsp;/g, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** "&gt;7,5T DMC | 11:00" -> { minutes: 660, weightClass: ">7.5T" } */
function parseTimeCell(cellText) {
  if (!cellText) return { minutes: null, weightClass: null };
  var timeMatch = cellText.match(/(\d+):(\d{2})/);
  var minutes = timeMatch ? Number(timeMatch[1]) * 60 + Number(timeMatch[2]) : null;
  var weightClass = null;
  if (cellText.indexOf('>7,5T') > -1) weightClass = '>7.5T';
  else if (cellText.indexOf('7,5T') > -1) weightClass = '<=7.5T';
  return { minutes: minutes, weightClass: weightClass };
}

function extractCheckpointNames(html) {
  var thRe = /<th[^>]*>([\s\S]*?)<\/th>/g;
  var names = [];
  var m;
  while ((m = thRe.exec(html))) {
    var clean = cleanName(m[1]);
    if (clean) names.push(clean);
  }
  return names;
}

function extractRow(html, iconFile) {
  var iconRe = new RegExp('<img src="images/' + iconFile + '\\.gif"');
  var iconMatch = iconRe.exec(html);
  if (!iconMatch) return null;
  var trStart = html.lastIndexOf('<tr>', iconMatch.index);
  var trEnd = html.indexOf('</tr>', iconMatch.index);
  if (trStart === -1 || trEnd === -1) return null;
  var rowHtml = html.slice(trStart, trEnd);
  var tdRe = /<td[^>]*class="dane1?"[^>]*>([\s\S]*?)<\/td>/g;
  var cells = [];
  var m;
  while ((m = tdRe.exec(rowHtml))) cells.push(cleanCell(m[1]));
  return cells;
}

function parseWaitTimesPage(html) {
  var names = extractCheckpointNames(html);
  var truckCells = extractRow(html, 'ciezarowka');
  var carCells = extractRow(html, 'auto');

  if (names.length === 0 || !truckCells) {
    throw new ConnectorError('granica.gov.pl page parsed to 0 checkpoints or a missing truck row - the page structure may have changed');
  }
  if (truckCells.length !== names.length) {
    throw new ConnectorError('granica.gov.pl: checkpoint count (' + names.length + ') does not match truck-row cell count (' + truckCells.length + ') - column alignment can no longer be trusted');
  }

  return names.map(function (name, i) {
    var truck = parseTimeCell(truckCells[i]);
    var car = carCells && carCells[i] !== undefined ? parseTimeCell(carCells[i]) : { minutes: null };
    return {
      name: name,
      truckMinutes: truck.minutes,
      truckWeightClass: truck.weightClass,
      carMinutes: car.minutes,
      rawText: 'truck: ' + (truckCells[i] || '-') + (carCells ? ' | car: ' + (carCells[i] || '-') : ''),
    };
  });
}

async function fetchGranicaBorders() {
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, config.requestTimeoutMs);
  var res;
  try {
    res = await fetch('https://granica.gov.pl/index_wait.php?p=u&v=pl&k=w', {
      headers: { 'User-Agent': config.userAgent, Accept: 'text/html' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new ConnectorError('granica.gov.pl request failed: ' + err.message, err);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new ConnectorError('granica.gov.pl responded with HTTP ' + res.status);

  var html = await res.text();
  var records = parseWaitTimesPage(html);
  var fetchedAt = new Date().toISOString();
  return records.map(function (r) { return normalizer.makeBorderCrossingFromGranica(r, { fetchedAt: fetchedAt }); });
}

module.exports = {
  fetchGranicaBorders: fetchGranicaBorders,
  parseWaitTimesPage: parseWaitTimesPage,
  parseTimeCell: parseTimeCell,
  ConnectorError: ConnectorError,
};
