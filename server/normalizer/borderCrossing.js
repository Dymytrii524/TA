'use strict';
/**
 * Normalized internal schema for border-crossing data, per the brief:
 *
 *   BorderCrossing { checkpointId, countryPair, direction, vehicleType,
 *                     queueLength, queueTimeMinutes, updatedAt, source, sourceUrl }
 *
 * Extended with lat/lon and a status colour, since both are needed for the
 * map + colour-coded table the UI section of the brief asks for, even
 * though the schema line didn't spell them out.
 */

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-zа-яёіїєґ0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * DPSU's own 4-state colour (grey/green/blue/red) mapped onto the site's
 * existing "Зона надійності" semantic (green/yellow/red). "grey" is kept
 * as its own 'unknown' state rather than folded into green or red - most
 * grey entries in the source data are simply closed/unmonitored
 * checkpoints, and silently calling that "green" would misrepresent it.
 */
var STATUS_MAP = { grey: 'unknown', green: 'green', blue: 'yellow', red: 'red' };

function mapStatus(dpsuColor) {
  return STATUS_MAP[dpsuColor] || 'unknown';
}

/**
 * Extracts whatever structured numbers we can from DPSU's free-text
 * "state_of_busy" field (it's an ad-hoc HTML string per checkpoint, not a
 * documented schema), but ALWAYS keeps the original text too - if a
 * checkpoint's phrasing doesn't match our regexes, the UI still has
 * something honest to show instead of a silently wrong number.
 */
function parseQueueText(rawHtml) {
  var text = String(rawHtml || '').replace(/<br\s*\/?>/gi, ' | ');
  var carsWaiting = text.match(/Кількість легкових авто[^:]*:\s*(\d+)/);
  var trucksWaiting = text.match(/Кількість вантажних авто[^:]*:\s*(\d+)/);
  var carThroughput = text.match(/Швидкість оформлення легкових[^:]*:\s*(\d+)/);
  var truckThroughput = text.match(/Швидкість оформлення вантажних[^:]*:\s*(\d+)/);
  return {
    raw: text.trim(),
    carsWaiting: carsWaiting ? Number(carsWaiting[1]) : null,
    trucksWaiting: trucksWaiting ? Number(trucksWaiting[1]) : null,
    carThroughputPerHour: carThroughput ? Number(carThroughput[1]) : null,
    truckThroughputPerHour: truckThroughput ? Number(truckThroughput[1]) : null,
  };
}

/**
 * @param {object} raw - one parsed <option> record from the DPSU map page
 * (see connectors/dpsuBorders.js for the exact fields it extracts)
 */
function makeBorderCrossingFromDpsu(raw, opts) {
  var queue = parseQueueText(raw.stateOfBusy);
  var lat = parseFloat(raw.lat);
  var lon = parseFloat(raw.lon);
  return {
    checkpointId: 'dpsu-' + slugify(raw.value || raw.innerText),
    name: raw.innerText,
    countryPair: { from: 'UA', to: raw.countryIso },
    vehicleType: raw.vehicleType,
    isOpen: raw.state === 'відкритий',
    status: mapStatus(raw.color),
    queue: { carsWaiting: queue.carsWaiting, trucksWaiting: queue.trucksWaiting,
      carThroughputPerHour: queue.carThroughputPerHour, truckThroughputPerHour: queue.truckThroughputPerHour,
      raw: queue.raw },
    queueLength: queue.trucksWaiting != null ? queue.trucksWaiting : queue.carsWaiting,
    queueTimeMinutes: null, // DPSU doesn't publish a direct ETA - not fabricating one from throughput+count, see README note
    category: raw.category || null,
    location: raw.location || null,
    lat: isFinite(lat) ? lat : null,
    lon: isFinite(lon) ? lon : null,
    // DPSU's data-created_at has no timezone marker; live-fetch samples during
    // development landed within minutes of the request's own UTC clock, so
    // it's treated as UTC here - re-verify if timestamps start looking ~3h off.
    updatedAt: (raw.createdAt ? new Date(raw.createdAt.replace(' ', 'T') + 'Z').toISOString() : (opts && opts.fetchedAt) || new Date().toISOString()),
    source: 'ДПСУ',
    sourceUrl: 'https://dpsu.gov.ua/en/map',
  };
}

/**
 * granica.gov.pl reports estimated wait TIME (hours) per checkpoint per
 * vehicle category, not a queue headcount like DPSU - a genuinely
 * different measurement, so the queue sub-object's shape differs
 * (trucksWaitMinutes/carsWaitMinutes) rather than being forced into
 * DPSU's carsWaiting/trucksWaiting counts.
 *
 * @param {object} raw - {name, truckMinutes, truckWeightClass, carMinutes}
 *   from connectors/granicaBorders.js
 */
function makeBorderCrossingFromGranica(raw, opts) {
  var hasAnyData = raw.truckMinutes != null || raw.carMinutes != null;
  return {
    checkpointId: 'granica-' + slugify(raw.name),
    name: raw.name,
    countryPair: { from: 'UA', to: 'PL' },
    direction: 'pl-to-ua', // this source measures traffic leaving Poland ("WYJAZD Z RP")
    vehicleType: 'road',
    isOpen: true, // granica.gov.pl only lists operating checkpoints; closures aren't represented as rows
    status: hasAnyData ? statusFromWaitMinutes(raw.truckMinutes != null ? raw.truckMinutes : raw.carMinutes) : 'unknown',
    queue: {
      trucksWaitMinutes: raw.truckMinutes,
      truckWeightClass: raw.truckWeightClass || null,
      carsWaitMinutes: raw.carMinutes,
      raw: raw.rawText || '',
    },
    queueLength: null, // granica.gov.pl gives wait time, not a vehicle count - not fabricating one
    queueTimeMinutes: raw.truckMinutes != null ? raw.truckMinutes : raw.carMinutes,
    category: null,
    location: null,
    lat: null,
    lon: null, // granica.gov.pl's table has no coordinates; see SOURCES.md re: geocoding as a follow-up
    updatedAt: (opts && opts.fetchedAt) || new Date().toISOString(),
    source: 'granica.gov.pl (KAS)',
    sourceUrl: 'https://granica.gov.pl/index_wait.php?p=u&v=pl&k=w',
  };
}

/** granica.gov.pl doesn't publish a colour itself - this derives the site's
 * green/yellow/red semantic from the wait-time thresholds visible in the
 * live data (0h clearly fine, several hours clearly bad); the exact cutoffs
 * are a reasonable judgement call, not a value from the source itself, so
 * keep them easy to find and change here if they turn out to feel wrong in
 * practice. */
function statusFromWaitMinutes(minutes) {
  if (minutes == null) return 'unknown';
  if (minutes <= 60) return 'green';
  if (minutes <= 240) return 'yellow';
  return 'red';
}

module.exports = {
  makeBorderCrossingFromDpsu: makeBorderCrossingFromDpsu,
  makeBorderCrossingFromGranica: makeBorderCrossingFromGranica,
  parseQueueText: parseQueueText,
  mapStatus: mapStatus,
  statusFromWaitMinutes: statusFromWaitMinutes,
  slugify: slugify,
};
