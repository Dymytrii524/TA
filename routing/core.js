'use strict';
/**
 * Shared routing core, implementing (a corrected version of) the flowchart's
 * cascade: try a direct main-haul route -> substitute the nearest servable
 * hub for whichever endpoint isn't covered -> fall back to nearest hub on
 * BOTH ends -> guaranteed pure-auto route.
 *
 * `mainHaulModes` is an ordered list of { name, group } (e.g. [sea, rail] for
 * the tri-modal algorithm, or just [air] / [rail] for the two-mode ones) -
 * this is what lets all three requested algorithms share one implementation,
 * matching how the flowchart for sea+rail+auto was asked to be reused for
 * plane+auto and rail+auto.
 *
 * See ALGORITHM_NOTES.md for the list of correctness issues found in the
 * original flowchart and how each is fixed here.
 */

const { findNearest } = require('./geo');

function leg(modeName, from, to, confirmed, source) {
  return { mode: modeName, from: from.id, to: to.id, confirmed, source: source || null };
}

function autoLeg(autoGroup, from, to) {
  if (from.id === to.id) return null; // zero-length leg, e.g. hub *is* the endpoint
  const direct = autoGroup.findDirect(from.id, to.id);
  return leg('авто', from, to, !!direct, direct ? direct.source : 'оцінка без підтвердження в Б-р авто');
}

function finalize(legs, log) {
  const clean = legs.filter(Boolean);
  return {
    ok: clean.length > 0,
    legs: clean,
    log,
    summary: clean
      .map((l) => `${l.mode} ${l.from}→${l.to}${l.confirmed ? '' : ' (непідтверджено)'}`)
      .join(' + '),
  };
}

/**
 * Bridges the endpoint that main-haul `mode` does NOT cover, by walking
 * outward through nearest candidates (bounded, unlike the flowchart's
 * unbounded "recompute nearest again" loop) until one both (a) has a
 * confirmed main-haul leg to/from the known endpoint and (b) can be
 * connected to the true unknown endpoint by another mode or by auto.
 */
function bridgeUnknownEnd({ known, unknown, mode, allModes, autoGroup, maxRadiusKm, knownIsOrigin, log }) {
  const terminals = mode.group.allTerminals();
  const tried = new Set();
  const MAX_CANDIDATES = 3;

  for (let i = 0; i < MAX_CANDIDATES; i++) {
    const nearest = findNearest(unknown, terminals, { maxRadiusKm, exclude: tried });
    if (!nearest) break;
    tried.add(nearest.point.id);

    const mainDirect = knownIsOrigin
      ? mode.group.findDirect(known.id, nearest.point.id)
      : mode.group.findDirect(nearest.point.id, known.id);
    if (!mainDirect) {
      log.push(`${mode.name}: найближчий до "${unknown.id}" пункт "${nearest.point.id}" (${nearest.distanceKm.toFixed(0)} км) не має підтвердженого сполучення з "${known.id}" - пробуємо наступний.`);
      continue;
    }

    let bridge = null;
    for (const other of allModes) {
      if (other === mode) continue;
      const od = knownIsOrigin
        ? other.group.findDirect(nearest.point.id, unknown.id)
        : other.group.findDirect(unknown.id, nearest.point.id);
      if (od) {
        bridge = knownIsOrigin
          ? leg(other.name, nearest.point, unknown, true, od.source)
          : leg(other.name, unknown, nearest.point, true, od.source);
        break;
      }
    }
    if (!bridge) {
      bridge = knownIsOrigin
        ? autoLeg(autoGroup, nearest.point, unknown)
        : autoLeg(autoGroup, unknown, nearest.point);
    }

    const mainLeg = knownIsOrigin
      ? leg(mode.name, known, nearest.point, true, mainDirect.source)
      : leg(mode.name, nearest.point, known, true, mainDirect.source);

    return knownIsOrigin ? [mainLeg, bridge] : [bridge, mainLeg];
  }
  return null;
}

/**
 * @param {object} opts
 * @param {{name:string, group:object}[]} opts.mainHaulModes  priority order
 * @param {object} opts.autoGroup
 * @param {{id:string,lat:number,lon:number}} opts.p1  loading point
 * @param {{id:string,lat:number,lon:number}} opts.p2  unloading point
 * @param {number} [opts.maxRadiusKm]
 */
function resolveMultimodal({ mainHaulModes, autoGroup, p1, p2, maxRadiusKm = 400 }) {
  const log = [];

  // Step 1 - direct main-haul route, tried in mode priority order (sea before
  // rail, as in the flowchart; a single mode for the two-mode algorithms).
  for (const mode of mainHaulModes) {
    const direct = mode.group.findDirect(p1.id, p2.id);
    if (direct) {
      log.push(`Прямий маршрут "${p1.id}"→"${p2.id}" знайдено в ${direct.source}.`);
      return finalize([leg(mode.name, p1, p2, true, direct.source)], log);
    }
  }
  log.push('Прямого маршруту немає в жодній БД основного плеча.');

  // Step 2 - one endpoint is a known hub for some mode, the other isn't:
  // anchor on the known end and bridge to the unknown one.
  for (const mode of mainHaulModes) {
    const p1known = mode.group.hasEndpoint(p1.id);
    const p2known = mode.group.hasEndpoint(p2.id);
    if (!p1known && !p2known) continue;

    if (p1known && !p2known) {
      const result = bridgeUnknownEnd({ known: p1, unknown: p2, mode, allModes: mainHaulModes, autoGroup, maxRadiusKm, knownIsOrigin: true, log });
      if (result) {
        log.push(`${mode.name}: "${p1.id}" - відомий пункт, "${p2.id}" - замінено на найближчий доступний.`);
        return finalize(result, log);
      }
    }
    if (p2known && !p1known) {
      const result = bridgeUnknownEnd({ known: p2, unknown: p1, mode, allModes: mainHaulModes, autoGroup, maxRadiusKm, knownIsOrigin: false, log });
      if (result) {
        log.push(`${mode.name}: "${p2.id}" - відомий пункт, "${p1.id}" - замінено на найближчий доступний.`);
        return finalize(result, log);
      }
    }
  }

  // Step 3 - neither endpoint matches ANY main-haul mode: snap BOTH ends to
  // the nearest hub of one mode and check whether that mode connects them
  // (the flowchart's fully-degraded "Б.д. станцій з П1 до П1/1 ... П2/2" case).
  for (const mode of mainHaulModes) {
    const terminals = mode.group.allTerminals();
    // exclude p1/p2 themselves - if either were an exact terminal match with
    // a usable direct route, step 1 or step 2 would already have returned.
    const nearP1 = findNearest(p1, terminals, { maxRadiusKm, exclude: new Set([p1.id, p2.id]) });
    if (!nearP1) continue;
    const nearP2 = findNearest(p2, terminals, { maxRadiusKm, exclude: new Set([p1.id, p2.id, nearP1.point.id]) });
    if (!nearP2) continue;

    const midDirect = mode.group.findDirect(nearP1.point.id, nearP2.point.id);
    if (!midDirect) {
      log.push(`${mode.name}: найближчі хаби знайдено ("${nearP1.point.id}", "${nearP2.point.id}"), але підтвердженого сполучення між ними немає.`);
      continue;
    }

    const legs = [
      autoLeg(autoGroup, p1, nearP1.point),
      leg(mode.name, nearP1.point, nearP2.point, true, midDirect.source),
      autoLeg(autoGroup, nearP2.point, p2),
    ];
    log.push(`${mode.name}: обидва кінці замінено на найближчі хаби, підтверджено проміжне сполучення.`);
    return finalize(legs, log);
  }

  // Step 4 - ultimate fallback, made explicit (the flowchart implies but
  // never draws an always-reachable base case): straight trucking.
  log.push('Жодна з БД основного плеча не дала результату - маршрут повністю автотранспортом.');
  return finalize([autoLeg(autoGroup, p1, p2)], log);
}

module.exports = { resolveMultimodal, leg, autoLeg, finalize };
