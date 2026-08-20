'use strict';
/**
 * Parser tests against a saved, trimmed fixture (4 checkpoints, covering:
 * a >7.5T truck cell, a <=7.5T truck cell, a no-data grey cell, and a bus
 * row that should be ignored) - no network needed. --live also hits the
 * real page once as a smoke test.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var connector = require('../connectors/granicaBorders');
var normalizer = require('../normalizer/borderCrossing');

var fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures/granica_ua_sample.html'), 'utf8');

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

test('extracts exactly the 4 checkpoint header names, without a stray " |" from the trailing <br/>', function () {
  var records = connector.parseWaitTimesPage(fixtureHtml);
  assert.deepStrictEqual(records.map(function (r) { return r.name; }), ['Dorohusk', 'Zosin', 'Medyka', 'Malhowice']);
});

test('parseTimeCell reads H:MM into minutes and detects the >7.5T weight class', function () {
  var r = connector.parseTimeCell('>7,5T DMC | 11:00');
  assert.strictEqual(r.minutes, 660);
  assert.strictEqual(r.weightClass, '>7.5T');
});

test('parseTimeCell detects the <=7.5T weight class', function () {
  var r = connector.parseTimeCell('≤7,5T DMC* | 1:00');
  assert.strictEqual(r.minutes, 60);
  assert.strictEqual(r.weightClass, '<=7.5T');
});

test('an empty/grey cell (no data) parses to null minutes, not 0 or a crash', function () {
  var r = connector.parseTimeCell('');
  assert.strictEqual(r.minutes, null);
});

test('column order is preserved: truck minutes line up with the correct checkpoint', function () {
  var records = connector.parseWaitTimesPage(fixtureHtml);
  var byName = {};
  records.forEach(function (r) { byName[r.name] = r; });
  assert.strictEqual(byName.Dorohusk.truckMinutes, 660);
  assert.strictEqual(byName.Zosin.truckMinutes, 60);
  assert.strictEqual(byName.Medyka.truckMinutes, 300);
  assert.strictEqual(byName.Malhowice.truckMinutes, null, 'the grey no-data cell for Malhowice');
});

test('the bus row is not mistaken for the truck or car row', function () {
  var records = connector.parseWaitTimesPage(fixtureHtml);
  var dorohusk = records.filter(function (r) { return r.name === 'Dorohusk'; });
  assert.strictEqual(dorohusk.length, 1, 'one record per checkpoint, not one per vehicle-type row');
  assert.strictEqual(dorohusk[0].truckMinutes, 660); // not the bus row's 0:00
});

test('normalizer derives green/yellow/red thresholds from wait minutes', function () {
  assert.strictEqual(normalizer.statusFromWaitMinutes(0), 'green');
  assert.strictEqual(normalizer.statusFromWaitMinutes(60), 'green');
  assert.strictEqual(normalizer.statusFromWaitMinutes(120), 'yellow');
  assert.strictEqual(normalizer.statusFromWaitMinutes(660), 'red');
  assert.strictEqual(normalizer.statusFromWaitMinutes(null), 'unknown');
});

test('makeBorderCrossingFromGranica produces the shared BorderCrossing envelope', function () {
  var records = connector.parseWaitTimesPage(fixtureHtml);
  var n = normalizer.makeBorderCrossingFromGranica(records[0]);
  assert.strictEqual(n.vehicleType, 'road');
  assert.strictEqual(n.countryPair.to, 'PL');
  assert.strictEqual(n.source, 'granica.gov.pl (KAS)');
  assert.ok(n.updatedAt);
});

test('mismatched header/row column counts fail loudly instead of silently misaligning', function () {
  var broken = fixtureHtml.replace('<th align="center" class="dane1">&nbsp;Malhowice&nbsp;<br/>\n</th>', '');
  assert.throws(function () { connector.parseWaitTimesPage(broken); }, connector.ConnectorError);
});

(async function () {
  if (process.argv.indexOf('--live') > -1) {
    console.log('\nLive smoke test (real network call to granica.gov.pl):');
    try {
      var live = await connector.fetchGranicaBorders();
      assert.ok(live.length >= 8, 'expected ~9 UA-PL checkpoints, got ' + live.length);
      console.log('  ok  - fetched', live.length, 'checkpoints, e.g.', live[0].name, '=', live[0].queue.trucksWaitMinutes, 'min');
      passed++;
    } catch (err) {
      console.error('  FAIL - live call failed:', err.message);
      process.exitCode = 1;
    }
  }
  console.log('\n' + passed + ' test(s) passed.');
  if (process.exitCode) console.log('Some tests FAILED - see above.');
})();
