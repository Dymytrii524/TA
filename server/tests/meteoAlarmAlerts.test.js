'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var connector = require('../connectors/meteoAlarmAlerts');

var fixtureXml = fs.readFileSync(path.join(__dirname, 'fixtures/meteoalarm_sample.xml'), 'utf8');

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

test('parseFeed extracts both alert entries from the fixture', function () {
  var alerts = connector.parseFeed(fixtureXml);
  assert.strictEqual(alerts.length, 2);
});

test('reads cap:event, cap:areaDesc, cap:severity, cap:onset, cap:expires', function () {
  var alerts = connector.parseFeed(fixtureXml);
  assert.strictEqual(alerts[0].event, 'Yellow high-temperature warning');
  assert.strictEqual(alerts[0].areaDesc, 'Świętokrzyskie Province Opatowski County');
  assert.strictEqual(alerts[0].severity, 'Moderate');
  assert.ok(alerts[0].onset);
  assert.ok(alerts[0].expires);
});

test('colorFromEventText reads MeteoAlarm\'s own awareness colour from the event text', function () {
  assert.strictEqual(connector.colorFromEventText('Yellow high-temperature warning'), 'yellow');
  assert.strictEqual(connector.colorFromEventText('Orange thunderstorm warning'), 'red');
  assert.strictEqual(connector.colorFromEventText('Red snow-ice warning'), 'red');
  assert.strictEqual(connector.colorFromEventText('something unexpected'), 'unknown');
});

test('parsed fixture entries get the correct colour end to end', function () {
  var alerts = connector.parseFeed(fixtureXml);
  assert.strictEqual(alerts[0].color, 'yellow');
  assert.strictEqual(alerts[1].color, 'red'); // Orange -> red in our 3-tier UI
});

(async function () {
  try {
    var alerts = await connector.fetchAlerts('XX');
    assert.deepStrictEqual(alerts, []);
    passed++;
    console.log('  ok  - fetchAlerts(\'XX\') (uncovered country) resolves to [] without a network call');
  } catch (err) {
    console.error('  FAIL - uncovered-country check:', err.message);
    process.exitCode = 1;
  }

  if (process.argv.indexOf('--live') > -1) {
    console.log('\nLive smoke test (real network calls to feeds.meteoalarm.org):');
    try {
      var ua = await connector.fetchAlerts('UA');
      var pl = await connector.fetchAlerts('PL');
      console.log('  ok  - UA:', ua.length, 'active alert(s) | PL:', pl.length, 'active alert(s)');
      if (pl[0]) console.log('        e.g. PL:', pl[0].event, '-', pl[0].areaDesc);
      passed++;
    } catch (err) {
      console.error('  FAIL - live call failed:', err.message);
      process.exitCode = 1;
    }
  }

  console.log('\n' + passed + ' test(s) passed.');
  if (process.exitCode) console.log('Some tests FAILED - see above.');
})();
