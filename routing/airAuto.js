'use strict';
/**
 * Algorithm 2 (developed from algorithm 1): plane + auto.
 * Same cascade as sea+rail+auto, but with a single main-haul mode (air), so
 * step 2's "bridge to a second mode before falling back to auto" collapses
 * straight to auto - which is exactly what you want for air freight, since
 * there is no cheaper intermediate mode to try before trucking.
 */

const { resolveMultimodal } = require('./core');
const { airGroup, roadGroup } = require('./db');

function route(p1, p2, opts = {}) {
  return resolveMultimodal({
    mainHaulModes: [{ name: 'авіа', group: airGroup }],
    autoGroup: roadGroup,
    p1,
    p2,
    ...opts,
  });
}

module.exports = { route };
