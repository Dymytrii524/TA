'use strict';
/**
 * Тести рушія SEARCH без залежностей: node search/tests/engine.test.js
 * Сценарії T16-T27 із ТЗ (A.12.1) на синтетичному світі + дим-тест на
 * справжніх CITIES/LISTINGS сайту (розбираються з index.html і test-data).
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var E = require('../engine');
var sc = require('./scenarios');
var S = sc.S;

var passed = 0, failed = 0, queue = [];
function test(name, fn) { queue.push({ name: name, fn: fn }); }

function ids(res) { return res.routes.map(function (r) { return r.route_id; }); }
function byId(res, id) { return res.routes.filter(function (r) { return r.route_id === id; })[0]; }
function reasons(res) { return (res.drone_diagnostics || []).map(function (d) { return d.reason; }); }
function noDrone(res) { return res.routes.filter(function (r) { return r.origin === 'post_drone'; }).length === 0; }

test('T16 останнє плече жд: дрон не створюється (ворота 1)', function () {
  return S.T16().then(function (r) {
    assert(noDrone(r)); assert.deepStrictEqual(reasons(r), ['not_last_auto_leg']);
    assert.strictEqual(r.drone_diagnostics[0].gate, 1);
    assert(r.routes.length === 1);
  });
});
test('T17 зона без дозволу: no_permit у warnings батьківського маршруту, без diagnostics поля немає', function () {
  return S.T17().then(function (r) {
    assert(noDrone(r)); assert.deepStrictEqual(reasons(r), ['no_permit']);
    assert(byId(r, 'rt_1').warnings.indexOf('no_permit') >= 0);
    return S.T17_no_diag();
  }).then(function (r) {
    assert(byId(r, 'rt_1').warnings.indexOf('no_permit') >= 0);
    assert.strictEqual(r.drone_diagnostics, undefined);
  });
});
test('T18 межа дальності: 42 км > 40 -> out_of_range, 39 км -> варіант є', function () {
  return S.T18_out().then(function (r) {
    assert(noDrone(r));
    var d = r.drone_diagnostics[0];
    assert.strictEqual(d.reason, 'out_of_range'); assert.strictEqual(d.gate, 3);
    assert.strictEqual(d.detail.limit_km, 40); assert.strictEqual(d.detail.margin, 0.8);
    return S.T18_in();
  }).then(function (r) {
    assert.deepStrictEqual(ids(r).sort(), ['rt_1', 'rt_1_d']);
    assert.strictEqual(r.drone_diagnostics, undefined);
  });
});
test('T19 вантаж: 80 кг > 20, ADR, живі тварини -> cargo_not_allowed', function () {
  return S.T19_payload().then(function (r) {
    assert(noDrone(r)); assert.strictEqual(r.drone_diagnostics[0].detail.rule, 'payload');
    assert.strictEqual(r.drone_diagnostics[0].detail.weight_kg, 80);
    return S.T19_adr();
  }).then(function (r) {
    assert.strictEqual(r.drone_diagnostics[0].reason, 'cargo_not_allowed'); assert.strictEqual(r.drone_diagnostics[0].detail.rule, 'adr');
    return S.T19_animals();
  }).then(function (r) {
    assert.strictEqual(r.drone_diagnostics[0].detail.rule, 'live_animals'); assert(byId(r, 'rt_1'));
  });
});
test('T20 четверте плече через площадку; max_legs і allow_extra_leg', function () {
  return S.T20().then(function (r) {
    var v = byId(r, 'rt_1_d');
    assert(v, 'є дрон-варіант'); assert.strictEqual(v.variant_of, 'rt_1');
    assert.deepStrictEqual(v.legs.map(function (l) { return l.mode; }), ['T', 'D', 'A']);
    assert.strictEqual(v.legs[1].to.kind, 'drone_pad'); assert.strictEqual(v.transships, 2);
    assert(byId(r, 'rt_1'), 'авто-варіант лишається');
    return S.T20_maxlegs();
  }).then(function (r) {
    assert(noDrone(r));
    var d = r.drone_diagnostics.filter(function (x) { return x.reason === 'max_legs_exceeded'; })[0];
    assert(d && d.detail.legs_required === 3 && d.detail.max_legs === 2);
    return S.T20_noextra();
  }).then(function (r) {
    assert(noDrone(r)); assert(reasons(r).indexOf('extra_leg_disabled') >= 0);
  });
});
test('T21 ризик погоди: дешевший дрон стоїть після батьківського; 8 м/с - звичайне сортування', function () {
  return S.T21_wind15().then(function (r) {
    var v = byId(r, 'rt_1_d'), p = byId(r, 'rt_1');
    assert(v.total_cost_eur < p.total_cost_eur, 'дрон дешевший');
    assert(v.score < p.score, 'а скор менший, тож без закріплення стояв би вище');
    assert(v.warnings.indexOf('weather_risk') >= 0); assert.strictEqual(v.order_pinned_below, 'rt_1');
    assert.strictEqual(v.legs[v.legs.length - 1].weather.ok, false);
    assert(ids(r).indexOf('rt_1_d') > ids(r).indexOf('rt_1'));
    return S.T21_wind8();
  }).then(function (r) {
    var v = byId(r, 'rt_1_d');
    assert.strictEqual(v.order_pinned_below, undefined); assert(v.warnings.indexOf('weather_risk') < 0);
    assert.strictEqual(ids(r)[0], 'rt_1_d');
  });
});
test('T22 ні лота, ні площадки: жодного дрон-поля; з diagnostics - обидва коди', function () {
  return S.T22().then(function (r) {
    assert.deepStrictEqual(ids(r), ['rt_1']); assert.strictEqual(r.drone_cta, undefined);
    assert.strictEqual(r.drone_diagnostics, undefined); assert.strictEqual(r.partial, false);
    return S.T22_diag();
  }).then(function (r) { assert.deepStrictEqual(reasons(r), ['no_drone_lot', 'no_landing_pad']); });
});
test('T23 площадка є, авто-лота немає -> drone_cta', function () {
  return S.T23().then(function (r) {
    assert(noDrone(r)); assert.strictEqual(r.drone_cta.action, 'create_lot');
    assert.strictEqual(r.drone_cta.missing_leg.mode, 'A'); assert(r.drone_cta.pad.distance_to_dest_km > 5 && r.drone_cta.pad.distance_to_dest_km < 7);
  });
});
test('T24 drone.allow=false: routes без post_drone побайтово збігаються; drone_disabled лише в діагностиці', function () {
  return Promise.all([S.T24_on(), S.T24_off(), S.T24_off_diag()]).then(function (a) {
    var on = a[0], off = a[1];
    assert(!noDrone(on), 'з allow є дрон-варіант');
    var onBranch = on.routes.filter(function (r) { return r.origin !== 'post_drone'; });
    assert.strictEqual(JSON.stringify(onBranch), JSON.stringify(off.routes));
    assert.strictEqual(off.drone_diagnostics, undefined);
    assert.strictEqual(a[2].drone_diagnostics[0].reason, 'drone_disabled');
  });
});
test('T25 перевищення бюджету: partial, drone_skipped=timeout, лише гілки', function () {
  return S.T25().then(function (r) {
    assert.strictEqual(r.partial, true); assert.strictEqual(r.drone_skipped, 'timeout'); assert(noDrone(r)); assert(r.routes.length >= 1);
  });
});
test('T26 погода недоступна: ok=null, weather_risk, partial, вигаданих значень немає', function () {
  return S.T26().then(function (r) {
    var v = byId(r, 'rt_1_d'), w = v.legs[v.legs.length - 1].weather;
    assert.strictEqual(w.ok, null); assert.strictEqual(w.wind_ms, null); assert(w.source_error);
    assert(v.warnings.indexOf('weather_risk') >= 0); assert.strictEqual(r.partial, true);
    assert(ids(r).indexOf('rt_1_d') > ids(r).indexOf('rt_1'), 'закріплений під батьком');
  });
});
test('T27 score гілок не залежить від дрон-варіантів', function () {
  return Promise.all([S.T27(), sc.S.T24_off()]).then(function (a) {
    var on = a[0];
    assert(!noDrone(on)); assert(on.routes.filter(function (r) { return r.origin === 'branch'; }).length >= 2);
    var off = require('../engine').search(sc.request({ drone: { allow: false, diagnostics: false } }), sc.world({ directDrone: true, extraBranch: true, dronePrice: 10 }), {});
    return off.then(function (o) {
      on.routes.filter(function (r) { return r.origin === 'branch'; }).forEach(function (r) {
        assert.strictEqual(r.score, byId(o, r.route_id).score, r.route_id);
      });
    });
  });
});
test('детермінізм: два запуски дають ідентичну відповідь', function () {
  return Promise.all([S.T21_wind15(), S.T21_wind15()]).then(function (a) {
    assert.strictEqual(JSON.stringify(a[0]), JSON.stringify(a[1]));
  });
});
test('порядок видачі: score монотонний, крім закріплених', function () {
  return S.T27().then(function (r) {
    var prev = -Infinity;
    r.routes.forEach(function (x) { if (!x.order_pinned_below) { assert(x.score >= prev); prev = x.score; } });
  });
});
test('порожня видача: fallback-блоки, а не помилка', function () {
  var w = sc.world({});
  return E.search({ origin: 'o', destination: 'far', weight_t: 1, modes: ['A'], criterion: 'cost', radius_km: { origin: 300, destination: 300 } }, w, {}).then(function (r) {
    assert.deepStrictEqual(r.routes, []); assert(Array.isArray(r.possible_links)); assert(Array.isArray(r.companies_on_direction));
  });
});

/* ---------- дим-тест на справжніх даних сайту ---------- */
function loadSiteData() {
  var root = path.join(__dirname, '..', '..');
  var html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  function grab(name) {
    var i = html.indexOf('var ' + name + ' = [');
    var j = html.indexOf('\n];', i);
    return (new Function('return ' + html.slice(html.indexOf('[', i), j + 2) + ';'))();
  }
  var listings = grab('LISTINGS');
  ['europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania'].forEach(function (c) {
    var f = path.join(root, 'test-data', 'listings-' + c + '.json');
    if (fs.existsSync(f)) listings = listings.concat(JSON.parse(fs.readFileSync(f, 'utf8')).listings);
  });
  return { cities: grab('CITIES'), listings: listings };
}
test('справжні дані: пошук працює, маршрути впорядковані й мають потрібні поля', function () {
  var data = loadSiteData();
  assert(data.cities.length > 100 && data.listings.length > 1000, 'дані завантажено');
  var t0 = Date.now();
  return E.search({ origin: 'kyiv', destination: 'berlin', weight_t: 10, modes: ['A', 'T', 'M', 'F', 'D'], criterion: 'balanced', radius_km: { origin: 300, destination: 300 }, drone: { diagnostics: true } }, data, {}).then(function (r) {
    console.log('    справжні дані: ' + r.routes.length + ' маршрутів за ' + (Date.now() - t0) + ' мс, гілка: ' + r.branch_reached);
    assert(Array.isArray(r.routes)); assert.strictEqual(r.base_currency_code, 'EUR'); assert.strictEqual(r.fx.demo, true);
    r.routes.forEach(function (x) {
      assert(/^rt_\d+(_d)?$/.test(x.route_id)); assert(x.legs.length >= 1 && x.legs.length <= 4);
      assert(x.total_cost_eur >= 0 && x.total_time_h >= 0);
    });
  });
});

function run() {
  return queue.reduce(function (chain, t) {
    return chain.then(function () {
      return Promise.resolve().then(t.fn).then(function () { passed++; console.log('  ok   ' + t.name); },
        function (e) { failed++; console.log('  FAIL ' + t.name + '\n       ' + (e && e.message)); });
    });
  }, Promise.resolve()).then(function () {
    console.log('\n' + passed + ' із ' + (passed + failed) + ' тестів пройдено');
    process.exit(failed ? 1 : 0);
  });
}
run();
