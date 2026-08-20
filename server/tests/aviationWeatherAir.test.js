'use strict';
var assert = require('assert');
var connector = require('../connectors/aviationWeatherAir');

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

function withMockedFetch(handler, fn) {
  var original = global.fetch;
  global.fetch = function (url) { return Promise.resolve(handler(url)); };
  return fn().finally(function () { global.fetch = original; });
}

function jsonResponse(body, status) {
  return { ok: (status || 200) < 300, status: status || 200, json: function () { return Promise.resolve(body); } };
}
function noContentResponse() {
  return { ok: true, status: 204, json: function () { return Promise.resolve(null); } };
}

var SAMPLE_METAR = [{
  icaoId: 'EPWA', reportTime: '2026-08-20T18:30:00.000Z', temp: 19, wdir: 200, wspd: 3,
  visib: '6+', rawOb: 'METAR EPWA 201830Z 20003KT CAVOK 19/16 Q1010 NOSIG',
  lat: 52.163, lon: 20.961, fltCat: 'VFR',
}];
var SAMPLE_TAF = [{ rawTAF: 'TAF EPWA ...', issueTime: '2026-08-20T18:00:00Z', validTimeFrom: 1787000000, validTimeTo: 1787100000 }];

(async function () {
  console.log('Connector tests (mocked fetch, no real network):');

  await withMockedFetch(
    function (url) { return url.indexOf('/metar') > -1 ? jsonResponse(SAMPLE_METAR) : jsonResponse(SAMPLE_TAF); },
    async function () {
      var wp = await connector.fetchAirWeather({ icao: 'epwa', locationLabel: 'Warsaw' });
      test('fetchAirWeather uppercases the ICAO code and returns transportMode air', function () {
        assert.strictEqual(wp.transport_mode, 'air');
        assert.strictEqual(wp.payload.icao, 'EPWA');
      });
      test('surfaces AviationWeather\'s own fltCat rather than recomputing VFR/MVFR/IFR/LIFR', function () {
        assert.strictEqual(wp.payload.metar.flightCategory, 'VFR');
      });
      test('parses TAF validity window from unix seconds to ISO', function () {
        assert.strictEqual(wp.payload.taf.validFrom, new Date(1787000000 * 1000).toISOString());
      });
    }
  );

  await withMockedFetch(
    function () { return noContentResponse(); },
    async function () {
      var wp = await connector.fetchAirWeather({ icao: 'UKBB', locationLabel: 'Kyiv' });
      test('HTTP 204 (no current data for this station) is a valid result, not a thrown error', function () {
        assert.strictEqual(wp.payload.metar, null);
        assert.strictEqual(wp.payload.taf, null);
      });
    }
  );

  await withMockedFetch(
    function () { return jsonResponse(null, 503); },
    async function () {
      try {
        await connector.fetchAirWeather({ icao: 'EPWA', locationLabel: 'Warsaw' });
        console.error('  FAIL - should throw ConnectorError on HTTP 503');
        process.exitCode = 1;
      } catch (err) {
        test('a real HTTP error (503) throws ConnectorError, unlike the benign 204 case', function () {
          assert.ok(err instanceof connector.ConnectorError);
        });
      }
    }
  );

  try {
    await connector.fetchAirWeather({ icao: '', locationLabel: 'Nowhere' });
    console.error('  FAIL - fetchAirWeather should require an ICAO code');
    process.exitCode = 1;
  } catch (err) {
    test('fetchAirWeather requires an ICAO code', function () {
      assert.ok(err instanceof connector.ConnectorError);
    });
  }

  if (process.argv.indexOf('--live') > -1) {
    console.log('\nLive smoke test (real network calls to aviationweather.gov):');
    try {
      var live = await connector.fetchAirWeather({ icao: 'EDDM', locationLabel: 'Munich (live)' });
      console.log('  ok  - EDDM:', live.payload.metar ? live.payload.metar.raw : 'no METAR');
      passed++;
    } catch (err) {
      console.error('  FAIL - live call failed:', err.message);
      process.exitCode = 1;
    }
  }

  console.log('\n' + passed + ' test(s) passed.');
  if (process.exitCode) console.log('Some tests FAILED - see above.');
})();
