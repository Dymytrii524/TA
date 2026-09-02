'use strict';
/** Pure unit tests for the keyword-overlap retrieval - no network, no
 * server needed. Run with: node server/tests/qaRetrieval.test.js */

var assert = require('assert');
var qaRetrieval = require('../services/qaRetrieval');

var wiki = [
  { id: 'cmr-waybill', status: 'published', title: 'Накладна CMR: що це і навіщо потрібна', tags: ['cmr', 'накладна', 'документи'], summary: 'Міжнародна товарно-транспортна накладна.', body: 'CMR підтверджує договір перевезення.' },
  { id: 'adr-dangerous-goods', status: 'published', title: 'ADR та класи небезпечних вантажів', tags: ['adr', 'небезпечні вантажі'], summary: 'Класифікація небезпечних вантажів.', body: 'Дев\'ять класів небезпеки.' },
  { id: 'draft-unpublished', status: 'draft', title: 'Чернетка про CMR', tags: ['cmr'], summary: 'ще не готово', body: 'cmr cmr cmr' },
];

var outputs = [
  { id: 'out-cmr-fields', status: 'published', title: 'Чек-лист: поля накладної CMR', tags: ['cmr', 'чек-лист'], summary: 'Що містить CMR.' },
];

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  - ' + name);
  } catch (err) {
    console.error('  FAIL - ' + name);
    console.error('        ' + err.message);
    process.exitCode = 1;
  }
}

console.log('qaRetrieval tests:');

test('finds the CMR wiki article and CMR output for a question about накладна CMR', function () {
  var results = qaRetrieval.search('Що таке накладна CMR?', wiki, outputs);
  var ids = results.map(function (r) { return r.item.id; });
  assert.ok(ids.indexOf('cmr-waybill') > -1, 'expected cmr-waybill in results');
  assert.ok(ids.indexOf('out-cmr-fields') > -1, 'expected out-cmr-fields in results');
});

test('ranks the title/tag match above an unrelated article', function () {
  var results = qaRetrieval.search('накладна CMR', wiki, outputs);
  assert.strictEqual(results[0].item.id, 'cmr-waybill');
});

test('excludes unpublished (draft) items even when they match strongly', function () {
  var results = qaRetrieval.search('CMR', wiki, outputs);
  var ids = results.map(function (r) { return r.item.id; });
  assert.strictEqual(ids.indexOf('draft-unpublished'), -1, 'draft item must never be returned');
});

test('annotates results with kind so wiki vs output is distinguishable', function () {
  var results = qaRetrieval.search('CMR', wiki, outputs);
  var kinds = results.map(function (r) { return r.kind; });
  assert.ok(kinds.indexOf('wiki') > -1);
  assert.ok(kinds.indexOf('output') > -1);
});

test('returns an empty array for a question with no matching tokens', function () {
  var results = qaRetrieval.search('погода на морі сьогодні', wiki, outputs);
  assert.deepStrictEqual(results, []);
});

test('returns an empty array for an empty/whitespace query instead of matching everything', function () {
  assert.deepStrictEqual(qaRetrieval.search('   ', wiki, outputs), []);
});

console.log('\n' + passed + ' test(s) passed.');
if (process.exitCode) console.log('Some tests FAILED - see above.');
