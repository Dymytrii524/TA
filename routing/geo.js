'use strict';
/**
 * "по координатах" sub-algorithm from the flowchart: given a point with no
 * exact match in a DB, find the nearest usable point out of a candidate list.
 *
 * Fixes two gaps in the original flowchart:
 *  - no distance limit was defined, so a "nearest" point on the other side of
 *    the planet would still count as a match -> we cap it with maxRadiusKm.
 *  - the flowchart recomputes "nearest" again after a failed check with no
 *    stated exit condition (risk of infinite loop) -> callers pass an
 *    `exclude` set so repeated calls walk outward through candidates instead
 *    of finding the same point forever.
 */

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * @param {{lat:number, lon:number}} origin
 * @param {{id:string, lat:number, lon:number}[]} candidates
 * @param {{maxRadiusKm?:number, exclude?:Set<string>}} opts
 * @returns {{point:object, distanceKm:number}|null}  null = explicit "not found"
 */
function findNearest(origin, candidates, opts = {}) {
  const { maxRadiusKm = 400, exclude = new Set() } = opts;
  let best = null;
  for (const c of candidates) {
    if (exclude.has(c.id)) continue;
    const d = haversineKm(origin, c);
    if (d > maxRadiusKm) continue;
    if (!best || d < best.distanceKm) best = { point: c, distanceKm: d };
  }
  return best;
}

module.exports = { haversineKm, findNearest, EARTH_RADIUS_KM };
