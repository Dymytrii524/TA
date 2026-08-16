'use strict';
/**
 * Algorithm 3 (point 8): rail + auto.
 * Same shared core as algorithms 1 and 2, single main-haul mode (rail).
 */

const { resolveMultimodal } = require('./core');
const { railGroup, roadGroup } = require('./db');

function route(p1, p2, opts = {}) {
  return resolveMultimodal({
    mainHaulModes: [{ name: 'залізниця', group: railGroup }],
    autoGroup: roadGroup,
    p1,
    p2,
    ...opts,
  });
}

module.exports = { route };
