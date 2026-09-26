'use strict';
/**
 * Тести читального зрізу /api/v1: node server/tests/v1.test.js
 * Семантика фільтрів перевіряється на маленькому наборі в пам’яті; з --real додатково
 * читається згенерований server/data/listings.canonical.json (10 773 заявки).
 */
var assert = require('assert');
var http = require('http');
var fs = require('fs');
var path = require('path');
var v1 = require('../v1/api');

function row(i, o) {
  return Object.assign({
    id: '00000000-0000-5000-8000-' + String(i).padStart(12, '0'), legacy_id: i, kind: 'transport', mode: 'auto', components: null,
    origin_city_id: 'kyiv', destination_city_id: 'warsaw', origin_country: 'UA', destination_country: 'PL', is_cross_border: true,
    ready_date: '2026-09-' + String(10 + i).padStart(2, '0'), cargo_type_id: 'build', weight_kg: '1000', volume_m3: null, price_amount: String(100 * i), price_currency: 'EUR',
    price_kind: 'fixed', company: { id: '11111111-1111-5111-8111-11111111111' + (i % 2), display_name: 'C' + (i % 2), verification_level: 'L0', verified_at: null },
    drone: null, status: 'active', source: 'import', expires_at: null, created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z'
  }, o || {});
}
var ROWS = [
  row(1), row(2, { kind: 'cargo', mode: 'rail', price_currency: 'USD' }), row(3, { mode: 'multi', components: ['auto', 'sea'] }),
  row(4, { destination_city_id: 'lviv', destination_country: 'UA', is_cross_border: false }), row(5, { status: 'paused' }),
  row(6, { mode: 'multi', components: ['rail', 'air'], cargo_type_id: 'food' }), row(7, { mode: 'drone', weight_kg: '5', drone: { range_km: '40', max_payload_kg: '8', drone_type: 'x', flight_permit: true } })
];
var api = v1.create({ rows: ROWS });
function get(port, p) {
  return new Promise(function (resolve, reject) {
    http.get({ port: port, path: p }, function (r) {
      var c = [];
      r.on('data', function (x) { c.push(x); });
      r.on('end', function () { var t = Buffer.concat(c).toString('utf8'); resolve({ status: r.statusCode, ct: r.headers['content-type'], json: JSON.parse(t) }); });
    }).on('error', reject);
  });
}
function method(port, m, p) {
  return new Promise(function (resolve, reject) {
    var r = http.request({ port: port, method: m, path: p }, function (x) { x.resume(); x.on('end', function () { resolve(x.statusCode); }); });
    r.on('error', reject); r.end();
  });
}
function send(r, s, b) { var t = JSON.stringify(b); r.writeHead(s, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(t) }); r.end(t); }
var server = http.createServer(function (req, res) {
  var parsed = require('url').parse(req.url, true);
  if (!api.handle(req, res, parsed, send)) { res.writeHead(404); res.end(); }
});
var passed = 0, failed = 0, queue = [];
function test(n, f) { queue.push({ n: n, f: f }); }
function ids(r) { return r.json.items.map(function (x) { return x.legacy_id; }); }

test('health чесно каже, що БД і Redis не розгорнуто', function (port) {
  return get(port, '/api/v1/health').then(function (r) {
    assert.strictEqual(r.json.status, 'degraded'); assert.strictEqual(r.json.db, 'down'); assert.strictEqual(r.json.redis, 'down'); assert.strictEqual(r.json.listings_loaded, ROWS.length);
  });
});
test('за замовчуванням тільки status=active; kind, mode, origin/destination', function (port) {
  return get(port, '/api/v1/listings?sort=date_asc').then(function (r) {
    assert.deepStrictEqual(ids(r), [1, 2, 3, 4, 6, 7]);
    return get(port, '/api/v1/listings?kind=cargo');
  }).then(function (r) { assert.deepStrictEqual(ids(r), [2]); return get(port, '/api/v1/listings?destination_city_id=lviv'); })
    .then(function (r) { assert.deepStrictEqual(ids(r), [4]); return get(port, '/api/v1/listings?status=paused'); })
    .then(function (r) { assert.deepStrictEqual(ids(r), [5]); });
});
test('components діє лише разом із mode=multi (як multiModes у SPA)', function (port) {
  return get(port, '/api/v1/listings?mode=multi&components=sea&sort=date_asc').then(function (r) {
    assert.deepStrictEqual(ids(r), [3]); return get(port, '/api/v1/listings?mode=multi&components=auto,rail&sort=date_asc');
  }).then(function (r) { assert.deepStrictEqual(ids(r), [3, 6]); return get(port, '/api/v1/listings?components=sea&sort=date_asc'); })
    .then(function (r) { assert.strictEqual(r.json.items.length, 6, 'без mode=multi components ігнорується'); });
});
test('border_scope, currency, країни, дати, cargo_type', function (port) {
  return get(port, '/api/v1/listings?border_scope=domestic').then(function (r) {
    assert.deepStrictEqual(ids(r), [4]); return get(port, '/api/v1/listings?currency=USD');
  }).then(function (r) { assert.deepStrictEqual(ids(r), [2]); return get(port, '/api/v1/listings?destination_country=UA'); })
    .then(function (r) { assert.deepStrictEqual(ids(r), [4]); return get(port, '/api/v1/listings?date_from=2026-09-13&date_to=2026-09-14&sort=date_asc'); })
    .then(function (r) { assert.deepStrictEqual(ids(r), [3, 4]); return get(port, '/api/v1/listings?cargo_type_id=food'); })
    .then(function (r) { assert.deepStrictEqual(ids(r), [6]); });
});
test('сортування price_desc і date_asc', function (port) {
  return get(port, '/api/v1/listings?sort=price_desc&limit=2').then(function (r) {
    assert.deepStrictEqual(ids(r), [7, 6]); return get(port, '/api/v1/listings?sort=date_asc&limit=2');
  }).then(function (r) { assert.deepStrictEqual(ids(r), [1, 2]); });
});
test('курсорна пагінація проходить усі записи без повторів', function (port) {
  var seen = [];
  function page(cursor) {
    return get(port, '/api/v1/listings?sort=date_asc&limit=2' + (cursor ? '&cursor=' + cursor : '')).then(function (r) {
      seen = seen.concat(ids(r));
      return r.json.page.has_more ? page(r.json.page.next_cursor) : null;
    });
  }
  return page(null).then(function () { assert.deepStrictEqual(seen, [1, 2, 3, 4, 6, 7]); });
});
test('422 із JSON Pointer на некоректні параметри', function (port) {
  return get(port, '/api/v1/listings?mode=plane&limit=500&origin_country=ua&cursor=zzz').then(function (r) {
    assert.strictEqual(r.status, 422); assert(/problem\+json/.test(r.ct));
    assert.deepStrictEqual(r.json.errors.map(function (e) { return e.pointer; }).sort(), ['/query/cursor', '/query/limit', '/query/mode', '/query/origin_country']);
  });
});
test('одна заявка: 200, 404, 422', function (port) {
  return get(port, '/api/v1/listings/' + ROWS[0].id).then(function (r) {
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.legacy_id, 1); return get(port, '/api/v1/listings/00000000-0000-5000-8000-999999999999');
  }).then(function (r) { assert.strictEqual(r.status, 404); return get(port, '/api/v1/listings/abc'); }).then(function (r) { assert.strictEqual(r.status, 422); });
});
test('довідники з seed: міста, типи вантажу, валюти', function (port) {
  return get(port, '/api/v1/reference/cities?country=PL').then(function (r) {
    assert(r.json.items.length > 1); r.json.items.forEach(function (c) { assert.strictEqual(c.country, 'PL'); assert(c.names.uk && c.names.en); });
    return get(port, '/api/v1/reference/cargo-types');
  }).then(function (r) { assert.strictEqual(r.json.items.length, 9); return get(port, '/api/v1/reference/currencies'); })
    .then(function (r) { assert(r.json.items.some(function (c) { return c.code === 'EUR'; })); });
});
test('нереалізоване - 501, запис - 501, невідомий шлях - 404', function (port) {
  return get(port, '/api/v1/auth/me').then(function (r) {
    assert.strictEqual(r.status, 501); return method(port, 'POST', '/api/v1/listings');
  }).then(function (s) { assert.strictEqual(s, 501); return get(port, '/api/v1/nothing'); }).then(function (r) { assert.strictEqual(r.status, 404); });
});
test('відсутній файл даних: 503 з інструкцією, а не порожня видача', function () {
  var a = v1.create({ dataFile: path.join(__dirname, 'no-such-file.json') });
  var s = http.createServer(function (req, res) {
    a.handle(req, res, require('url').parse(req.url, true), function (r, st, b) { var t = JSON.stringify(b); r.writeHead(st); r.end(t); });
  });
  return new Promise(function (ok) { s.listen(0, ok); }).then(function () { return get(s.address().port, '/api/v1/listings'); }).then(function (r) {
    s.close(); assert.strictEqual(r.status, 503); assert(/export_canonical/.test(r.json.detail));
  });
});
if (process.argv.indexOf('--real') >= 0) {
  test('REAL: 10 773 канонічні заявки, сортування й лічильники', function () {
    var f = path.join(__dirname, '..', 'data', 'listings.canonical.json');
    assert(fs.existsSync(f), 'спершу python sprint-0-backend/tools/export_canonical.py');
    var a = v1.create({}); var r = a.listings({ limit: '100' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.page.total_matching, 10773); assert.strictEqual(r.body.items.length, 100);
    assert.strictEqual(a.listings({ kind: 'transport', mode: 'drone' }).body.page.total_matching > 100, true);
  });
}
new Promise(function (ok) { server.listen(0, ok); }).then(function () {
  var port = server.address().port;
  return queue.reduce(function (chain, t) {
    return chain.then(function () {
      return Promise.resolve().then(function () { return t.f(port); }).then(function () { passed++; console.log('  ok   ' + t.n); },
        function (e) { failed++; console.log('  FAIL ' + t.n + '\n       ' + (e && e.message)); });
    });
  }, Promise.resolve());
}).then(function () { server.close(); console.log('\n' + passed + ' із ' + (passed + failed) + ' тестів пройдено'); process.exit(failed ? 1 : 0); });
