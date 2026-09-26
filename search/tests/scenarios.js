'use strict';
/**
 * Синтетичний світ для сценаріїв POST_DRONE T16-T27 (ТЗ, A.12.1).
 * Міста лежать на екваторі: 1 градус довготи = 111.19 км, тож відстані
 * в сценаріях (39 км, 42 км, 6 км) задаються довготою, а не вгадуються.
 */
var E = require('../engine');

var world = E.syntheticWorld;

function request(o) {
  o = o || {};
  return {
    origin: 'o', destination: 'p2', weight_t: o.weight_t === undefined ? 0.02 : o.weight_t, criterion: o.criterion || 'cost',
    modes: o.modes || ['A', 'T', 'M', 'D'], max_transships: 3,
    cargo: o.cargo, drone: Object.assign({ allow: true, allow_extra_leg: true, diagnostics: true }, o.drone || {})
  };
}

var wind = function (ms) { return function () { return Promise.resolve({ wind_ms: ms }); }; };

/** Кожен сценарій повертає Promise<відповідь>; expectations - у engine.test.js */
var S = {
  T16: function () { return E.search(request({ modes: ['M', 'T', 'D'] }), world({ lastLeg: 'rail', padDrone: true }), { weather: wind(5) }); },
  T17: function () { return E.search(request(), world({ directDrone: true }), { weather: wind(5), config: { no_fly_zones: { p2: { permit: false, zone: 'border_strip', permit_id: null } } } }); },
  T17_no_diag: function () { return E.search(request({ drone: { diagnostics: false } }), world({ directDrone: true }), { weather: wind(5), config: { no_fly_zones: { p2: { permit: false, zone: 'border_strip' } } } }); },
  T18_out: function () { return E.search(request(), world({ range: 42, directDrone: true }), { weather: wind(5) }); },
  T18_in: function () { return E.search(request({ drone: { diagnostics: false } }), world({ range: 39, directDrone: true }), { weather: wind(5) }); },
  T19_payload: function () { return E.search(request({ weight_t: 0.08 }), world({ range: 12, directDrone: true }), { weather: wind(5) }); },
  T19_adr: function () { return E.search(request({ cargo: { adr_class: 3 } }), world({ range: 12, directDrone: true }), { weather: wind(5) }); },
  T19_animals: function () { return E.search(request({ cargo: { live_animals: true } }), world({ range: 12, directDrone: true }), { weather: wind(5) }); },
  T20: function () { return E.search(request(), world({ padDrone: true, padTail: true }), { weather: wind(5) }); },
  T20_maxlegs: function () { return E.search(request(), world({ padDrone: true, padTail: true }), { weather: wind(5), config: { max_legs: 2 } }); },
  T20_noextra: function () { return E.search(request({ drone: { allow_extra_leg: false } }), world({ padDrone: true, padTail: true }), { weather: wind(5) }); },
  T21_wind15: function () { return E.search(request(), world({ directDrone: true, dronePrice: 10 }), { weather: wind(15) }); },
  T21_wind8: function () { return E.search(request(), world({ directDrone: true, dronePrice: 10 }), { weather: wind(8) }); },
  T22: function () { return E.search(request({ drone: { diagnostics: false } }), world({}), { weather: wind(5) }); },
  T22_diag: function () { return E.search(request(), world({}), { weather: wind(5) }); },
  T23: function () { return E.search(request({ drone: { diagnostics: false } }), world({ padDrone: true }), { weather: wind(5) }); },
  T24_on: function () { return E.search(request({ drone: { diagnostics: false } }), world({ directDrone: true, extraBranch: true }), { weather: wind(5) }); },
  T24_off: function () { return E.search(request({ drone: { allow: false, diagnostics: false } }), world({ directDrone: true, extraBranch: true }), { weather: wind(5) }); },
  T24_off_diag: function () { return E.search(request({ drone: { allow: false } }), world({ directDrone: true, extraBranch: true }), { weather: wind(5) }); },
  T25: function () {
    var t = 0;
    return E.search(request(), world({ directDrone: true }), { weather: wind(5), now: function () { t += 5000; return t; } });
  },
  T26: function () { return E.search(request({ drone: { diagnostics: false } }), world({ directDrone: true, dronePrice: 10 }), { weather: function () { return Promise.reject(new Error('weather down')); } }); },
  T27: function () { return E.search(request({ drone: { diagnostics: false } }), world({ directDrone: true, extraBranch: true, dronePrice: 10 }), { weather: wind(8) }); }
};

module.exports = { S: S, world: world, request: request };
