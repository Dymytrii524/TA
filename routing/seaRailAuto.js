'use strict';
/**
 * Algorithm 1: sea + rail + auto (the flowchart in the prompt).
 * Mode priority: sea first, then rail - matches the diagram, where the sea
 * DB group is queried before the flow ever reaches the rail DB group.
 */

const { resolveMultimodal } = require('./core');
const { seaGroup, railGroup, roadGroup } = require('./db');

function route(p1, p2, opts = {}) {
  return resolveMultimodal({
    mainHaulModes: [
      { name: 'море', group: seaGroup },
      { name: 'залізниця', group: railGroup },
    ],
    autoGroup: roadGroup,
    p1,
    p2,
    ...opts,
  });
}

module.exports = { route };
