'use strict';
/**
 * Parser tests against a saved, trimmed fixture (4 representative
 * checkpoints covering: raw <br> inside data-state_of_busy, double-escaped
 * quotes in institutional names, a multi-type [\"car\",\"person\"] value,
 * and a checkpoint with no coordinates) - no network needed. Run with
 * --live to also fetch the real page once as a smoke test.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var connector = require('../connectors/dpsuBorders');
var normalizer = require('../normalizer/borderCrossing');

var fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures/dpsu_map_sample.html'), 'utf8');

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

console.log('Parser tests (saved fixture, no network):');

test('parseOptions finds exactly the 4 checkpoint entries, skipping the "All" option', function () {
  var records = connector.parseOptions(fixtureHtml);
  assert.strictEqual(records.length, 4);
});

test('correctly finds the tag boundary despite a raw <br> inside data-state_of_busy', function () {
  var records = connector.parseOptions(fixtureHtml);
  var r = records[0];
  assert.strictEqual(r.innerText, 'Угринів - Долгобичув');
  assert.strictEqual(r.value, 'Угринів - Долгобичув');
});

test('parses queue numbers out of the free-text state_of_busy field', function () {
  var records = connector.parseOptions(fixtureHtml);
  var normalized = normalizer.makeBorderCrossingFromDpsu(records[0]);
  assert.strictEqual(normalized.queue.carsWaiting, 35);
  assert.strictEqual(normalized.queue.trucksWaiting, 473);
  assert.strictEqual(normalized.queue.carThroughputPerHour, 40);
  assert.strictEqual(normalized.queueLength, 473, 'queueLength should prefer trucksWaiting for a freight-focused site');
});

test('fixes DPSU\'s double-escaped quotes ("&amp;quot;" -> \'"\') in institutional names', function () {
  var records = connector.parseOptions(fixtureHtml);
  var r = records.find(function (x) { return x.value.indexOf('Нібулон') > -1; });
  assert.strictEqual(r.value, 'Термінал ТОВ "Нібулон"');
});

test('resolves a JSON-array multi-type value ("[\\"car\\",\\"person\\"]") to a single freight-relevant mode', function () {
  var records = connector.parseOptions(fixtureHtml);
  var r = records.find(function (x) { return x.value.indexOf('Ужгород') > -1; });
  assert.strictEqual(r.vehicleType, 'road');
});

test('maps DPSU color -> site status semantic (grey/green/blue/red -> unknown/green/yellow/red)', function () {
  assert.strictEqual(normalizer.mapStatus('grey'), 'unknown');
  assert.strictEqual(normalizer.mapStatus('green'), 'green');
  assert.strictEqual(normalizer.mapStatus('blue'), 'yellow');
  assert.strictEqual(normalizer.mapStatus('red'), 'red');
  assert.strictEqual(normalizer.mapStatus('purple'), 'unknown', 'unrecognized colors fail soft to unknown, not a crash');
});

test('a checkpoint with no coordinates gets lat/lon = null instead of NaN', function () {
  var records = connector.parseOptions(fixtureHtml);
  var r = records.find(function (x) { return x.value.indexOf('Нібулон') > -1; });
  var normalized = normalizer.makeBorderCrossingFromDpsu(r);
  assert.strictEqual(normalized.lat, null);
  assert.strictEqual(normalized.lon, null);
});

test('countryPair.to and vehicleType are set correctly across all 4 fixture entries', function () {
  var records = connector.parseOptions(fixtureHtml);
  var normalized = records.map(function (r) { return normalizer.makeBorderCrossingFromDpsu(r); });
  assert.deepStrictEqual(
    normalized.map(function (n) { return [n.countryPair.to, n.vehicleType]; }),
    [['PL', 'road'], ['PL', 'road'], ['UA', 'sea'], ['SK', 'road']]
  );
});

test('isOpen reflects the відкритий/закритий state', function () {
  var records = connector.parseOptions(fixtureHtml);
  var normalized = records.map(function (r) { return normalizer.makeBorderCrossingFromDpsu(r); });
  assert.strictEqual(normalized[0].isOpen, true);
  assert.strictEqual(normalized[2].isOpen, false);
});

(async function () {
  if (process.argv.indexOf('--live') > -1) {
    console.log('\nLive smoke test (real network call to dpsu.gov.ua):');
    try {
      var live = await connector.fetchDpsuBorders();
      assert.ok(live.length > 100, 'expected a few hundred checkpoints from the real page, got ' + live.length);
      var road = live.filter(function (n) { return n.vehicleType === 'road' && n.countryPair.to === 'PL'; });
      console.log('  ok  - fetched', live.length, 'checkpoints,', road.length, 'road crossings with Poland');
      passed++;
    } catch (err) {
      console.error('  FAIL - live call failed:', err.message);
      process.exitCode = 1;
    }
  }
  console.log('\n' + passed + ' test(s) passed.');
  if (process.exitCode) console.log('Some tests FAILED - see above.');
})();
