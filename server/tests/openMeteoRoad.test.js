'use strict';
/**
 * Zero-dependency tests (Node's built-in `assert`) so `node
 * server/tests/openMeteoRoad.test.js` just works with no install step.
 *
 * Two layers, on purpose:
 *  1. Parser-only tests run against the saved fixture - no network, no
 *     clock dependency. If Open-Meteo changes its JSON shape, THIS is what
 *     should fail, not a live user request.
 *  2. A fetch-mocked integration test for fetchRoadWeather() itself, using
 *     freshly-generated timestamps (not the static fixture) so the
 *     "find the current hour" logic is exercised deterministically
 *     regardless of what day the test happens to run on.
 *
 * Pass --live to also hit the real Open-Meteo API once, as a smoke test.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var connector = require('../connectors/openMeteoRoad');
var normalizer = require('../normalizer/weatherPoint');

var fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/openMeteo.sample.json'), 'utf8'));

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

test('describeWeatherCode maps known WMO codes to Ukrainian text', function () {
  assert.strictEqual(connector.describeWeatherCode(0), 'Ясно');
  assert.strictEqual(connector.describeWeatherCode(95), 'Гроза');
});

test('describeWeatherCode fails soft on an unknown code instead of throwing', function () {
  assert.strictEqual(connector.describeWeatherCode(999), 'Погодні умови (код 999)');
});

test('parseHourly reads the fixture\'s parallel arrays into flat records', function () {
  var rows = connector.parseHourly(fixture.hourly, 0, 24);
  assert.strictEqual(rows.length, 24);
  assert.strictEqual(rows[0].temperatureC, -0.5);
  assert.strictEqual(rows[0].precipitationMm, 0.4);
  assert.strictEqual(rows[0].windSpeedKmh, 12);
  assert.strictEqual(rows[13].conditionUk, 'Невеликий дощ');
  assert.strictEqual(rows[14].conditionUk, 'Зливи');
});

test('parseHourly stops at the end of the array instead of reading undefined', function () {
  var rows = connector.parseHourly(fixture.hourly, 20, 12);
  assert.strictEqual(rows.length, 4); // only 4 hours left from index 20
});

test('estimateRoadRisk flags ice risk from the fixture\'s sub-1C + precipitation hours', function () {
  var rows = connector.parseHourly(fixture.hourly, 0, 24);
  var flags = normalizer.estimateRoadRisk(rows);
  var codes = flags.map(function (f) { return f.code; });
  assert.ok(codes.indexOf('ice_risk') > -1, 'expected ice_risk from hour 0 (-0.5C, 0.4mm precip)');
});

test('estimateRoadRisk flags high wind from the fixture\'s 62-65 km/h hours', function () {
  var rows = connector.parseHourly(fixture.hourly, 0, 24);
  var flags = normalizer.estimateRoadRisk(rows);
  assert.ok(flags.some(function (f) { return f.code === 'high_wind'; }));
});

test('estimateRoadRisk flags heavy rain from the fixture\'s 11.5/13.2mm hours', function () {
  var rows = connector.parseHourly(fixture.hourly, 0, 24);
  var flags = normalizer.estimateRoadRisk(rows);
  assert.ok(flags.some(function (f) { return f.code === 'heavy_rain'; }));
});

test('estimateRoadRisk returns no flags for calm, dry, mild weather', function () {
  var calm = [{ temperatureC: 18, precipitationMm: 0, windSpeedKmh: 10 }];
  assert.deepStrictEqual(normalizer.estimateRoadRisk(calm), []);
});

test('makeWeatherPoint always sets the envelope fields the API/frontend rely on', function () {
  var point = normalizer.makeWeatherPoint({
    location: 'Kyiv', lat: 50.45, lon: 30.52, transportMode: 'road',
    sourceName: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', payload: { foo: 1 },
  });
  assert.strictEqual(point.transport_mode, 'road');
  assert.strictEqual(point.is_realtime, true);
  assert.ok(point.updated_at);
  assert.deepStrictEqual(point.alerts, []);
});

console.log('\nConnector integration tests (mocked fetch, no real network):');

function withMockedFetch(responseFactory, fn) {
  var original = global.fetch;
  global.fetch = function () {
    var response = responseFactory();
    return Promise.resolve(response);
  };
  return fn().finally(function () { global.fetch = original; });
}

function freshFixtureAroundNow() {
  // Build 24 hourly timestamps centred on "right now" so fetchRoadWeather's
  // "find the current hour" search has something real to find, regardless
  // of when this test suite runs.
  var time = [], temperature_2m = [], precipitation = [], wind_speed_10m = [], weather_code = [];
  var base = new Date();
  base.setHours(base.getHours() - 6, 0, 0, 0);
  for (var i = 0; i < 24; i++) {
    var d = new Date(base.getTime() + i * 3600 * 1000);
    time.push(d.toISOString().slice(0, 13) + ':00');
    temperature_2m.push(10 + i * 0.2);
    precipitation.push(0);
    wind_speed_10m.push(15);
    weather_code.push(1);
  }
  return { hourly: { time: time, temperature_2m: temperature_2m, precipitation: precipitation, wind_speed_10m: wind_speed_10m, weather_code: weather_code } };
}

(async function () {
  await withMockedFetch(
    function () { return { ok: true, json: function () { return Promise.resolve(freshFixtureAroundNow()); } }; },
    async function () {
      await (async function () {
        test('fetchRoadWeather returns a normalized WeatherPoint for a successful response', function () {});
        var point = await connector.fetchRoadWeather({ lat: 50.45, lon: 30.52, locationLabel: 'Kyiv' });
        assert.strictEqual(point.transport_mode, 'road');
        assert.strictEqual(point.location, 'Kyiv');
        assert.ok(point.payload.current, 'expected a "current" hour to be resolved from the mocked series');
        assert.strictEqual(point.payload.next12h.length, 12);
        passed++;
        console.log('  ok  - fetchRoadWeather resolves current hour + 12h forecast from mocked response');
      })();
    }
  );

  await withMockedFetch(
    function () { return { ok: false, status: 503 }; },
    async function () {
      try {
        await connector.fetchRoadWeather({ lat: 50.45, lon: 30.52, locationLabel: 'Kyiv' });
        console.error('  FAIL - fetchRoadWeather should throw on HTTP 503');
        process.exitCode = 1;
      } catch (err) {
        assert.ok(err instanceof connector.ConnectorError);
        passed++;
        console.log('  ok  - fetchRoadWeather throws ConnectorError (fail-soft) on HTTP error');
      }
    }
  );

  await withMockedFetch(
    function () { return { ok: true, json: function () { return Promise.resolve({ latitude: 1, longitude: 1 }); } }; },
    async function () {
      try {
        await connector.fetchRoadWeather({ lat: 50.45, lon: 30.52, locationLabel: 'Kyiv' });
        console.error('  FAIL - fetchRoadWeather should throw when "hourly" is missing (schema break)');
        process.exitCode = 1;
      } catch (err) {
        assert.ok(err instanceof connector.ConnectorError);
        assert.ok(/hourly/.test(err.message));
        passed++;
        console.log('  ok  - fetchRoadWeather detects a missing "hourly" block instead of writing garbage');
      }
    }
  );

  if (process.argv.indexOf('--live') > -1) {
    console.log('\nLive smoke test (real network call to Open-Meteo):');
    try {
      var live = await connector.fetchRoadWeather({ lat: 50.4501, lon: 30.5234, locationLabel: 'Kyiv (live)' });
      assert.ok(live.payload.current, 'expected a current hour from the real API');
      console.log('  ok  - live Open-Meteo call succeeded:', live.payload.current.conditionUk, live.payload.current.temperatureC + 'C');
      passed++;
    } catch (err) {
      console.error('  FAIL - live call failed:', err.message);
      process.exitCode = 1;
    }
  }

  console.log('\n' + passed + ' test(s) passed.');
  if (process.exitCode) console.log('Some tests FAILED - see above.');
})();
