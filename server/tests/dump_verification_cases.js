'use strict';
// Друкує справи різних результатів як JSON-масив (для перевірки за verification.schema.json)
var fs = require('fs'), path = require('path');
var E = require('../verification/engine');
var FX = path.join(__dirname, 'fixtures');
var V = fs.readFileSync(path.join(FX, 'vies.sample.json'), 'utf8'), W = fs.readFileSync(path.join(FX, 'bialaLista.sample.json'), 'utf8'), K = fs.readFileSync(path.join(FX, 'krs.sample.json'), 'utf8');
var SEED = path.join(__dirname, '..', '..', 'sprint-0-backend', 'seed');
var S = JSON.parse(fs.readFileSync(path.join(SEED, 'verification_sources.json'), 'utf8')), C = JSON.parse(fs.readFileSync(path.join(SEED, 'verification_checks.json'), 'utf8'));
var LIGHT = { sources: S.filter(function (s) { return { vies: 1, pl_white_list: 1, pl_krs: 1 }[s.id]; }), checks: C.filter(function (c) { return { vies: 1, pl_white_list: 1, pl_krs: 1 }[c.source_id] && c.required_for === 'L1'; }) };
function res(st, t) { return Promise.resolve({ status: st, headers: { get: function () { return 'application/json'; } }, text: function () { return Promise.resolve(t); } }); }
function ff(r) { return function (u) { var k = u.indexOf('vies') >= 0 ? 'vies' : u.indexOf('wl-api') >= 0 ? 'wl' : 'krs'; var v = r[k]; return typeof v === 'number' ? res(v, '') : res(200, v); }; }
var OK = { vies: V, wl: W, krs: K };
var PKP = { target_level: 'L1', identifiers: [{ kind: 'nip', value: '5250000251', country: 'PL' }], declared_name: 'Polskie Koleje Państwowe S.A.' };
var slp = function () { return Promise.resolve(); };
function go(routes, extra, input, then) {
  var e = E.createEngine(Object.assign({ fetch: ff(routes), sleep: slp, env: {}, cacheMs: 0 }, extra || {}));
  var r = e.createCase(input);
  return r.done.then(function () { if (then) then(e, r.case.id); return e.getCase(r.case.id); });
}
Promise.all([
  go(OK, {}, PKP),                                              // manual_review, блокуючі без ключа
  go(OK, { catalogs: LIGHT }, PKP),                             // approved автоматично
  go({ vies: V, wl: W, krs: 204 }, { catalogs: LIGHT }, PKP),   // rejected
  go({ vies: '{"isValid":false,"userError":"MS_UNAVAILABLE"}', wl: W, krs: K }, { catalogs: LIGHT }, PKP), // unavailable неблокуюче + approved
  go(OK, {}, PKP, function (e, id) { e.decide(id, { decision: 'approve', reason: 'Перевірено вручну за паперами', override_blocking: true }); }), // approved через override
  go(OK, {}, { target_level: 'L2', identifiers: [{ kind: 'nip', value: '5250000251', country: 'PL' }], declared_name: 'Polskie Koleje Państwowe S.A.' }), // L2
  go(OK, {}, { target_level: 'L1', identifiers: [{ kind: 'edrpou', value: '12345678', country: 'UA' }] })  // UA
]).then(function (cases) { process.stdout.write(JSON.stringify(cases)); });
