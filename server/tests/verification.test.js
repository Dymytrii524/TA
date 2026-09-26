'use strict';
/**
 * Тести модуля верифікації без залежностей: node server/tests/verification.test.js
 * Мережа не потрібна: fetch підміняється відповідями з живих знімків у fixtures/ (PKP S.A., NIP 5250000251).
 * З --live робиться один справжній прогін по трьох джерелах.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var http = require('http');
var os = require('os');
var engineMod = require('../verification/engine');
var sources = require('../verification/sources');
var verificationApi = require('../verification/api');

var FX = path.join(__dirname, 'fixtures');
function fx(n) { return fs.readFileSync(path.join(FX, n), 'utf8'); }
var VIES = fx('vies.sample.json'), WL = fx('bialaLista.sample.json'), KRS = fx('krs.sample.json');
var SEED = path.join(__dirname, '..', '..', 'sprint-0-backend', 'seed');
var ALL_SRC = JSON.parse(fs.readFileSync(path.join(SEED, 'verification_sources.json'), 'utf8'));
var ALL_CHK = JSON.parse(fs.readFileSync(path.join(SEED, 'verification_checks.json'), 'utf8'));

function res(status, text) {
  return Promise.resolve({ status: status, headers: { get: function () { return 'application/json'; } }, text: function () { return Promise.resolve(text); } });
}
/** Підроблений fetch: routes - {vies, wl, krs} -> текст, число (HTTP-статус) або функція */
function fakeFetch(routes, calls) {
  return function (u) {
    if (calls) calls.push(u);
    var key = u.indexOf('vies') >= 0 ? 'vies' : u.indexOf('wl-api') >= 0 ? 'wl' : u.indexOf('api-krs') >= 0 ? 'krs' : null;
    var r = routes[key];
    if (typeof r === 'function') return r(u);
    if (typeof r === 'number') return res(r, r === 204 ? '' : '{"message":"x"}');
    if (r === undefined) return Promise.reject(new Error('мережа вимкнена: ' + u));
    return res(200, r);
  };
}
var OK = { vies: VIES, wl: WL, krs: KRS };
var noSleep = function () { return Promise.resolve(); };
function mk(routes, extra) {
  return engineMod.createEngine(Object.assign({ fetch: fakeFetch(routes), sleep: noSleep, env: {}, cacheMs: 0 }, extra || {}));
}
var PKP = { target_level: 'L1', identifiers: [{ kind: 'nip', value: '525-000-02-51', country: 'PL' }], declared_name: 'Polskie Koleje Państwowe S.A.' };
function run(eng, input) { var r = eng.createCase(input); return r.done.then(function () { return eng.getCase(r.case.id); }); }
function st(c, id) { return c.results.filter(function (r) { return r.check_id === id; })[0]; }

var LIGHT = { sources: ALL_SRC.filter(function (s) { return { vies: 1, pl_white_list: 1, pl_krs: 1 }[s.id]; }),
  checks: ALL_CHK.filter(function (c) { return { vies: 1, pl_white_list: 1, pl_krs: 1 }[c.source_id] && c.required_for === 'L1'; }) };

var queue = [], passed = 0, failed = 0;
function test(n, f) { queue.push({ n: n, f: f }); }

/* ---------- коннектори ---------- */
test('VIES: розбір живого знімка', function () {
  return sources.vies({ country: 'PL', vat_number: '5250000251' }, { fetch: fakeFetch(OK), now: function () { return new Date(); } }).then(function (r) {
    assert.strictEqual(r.outcome, 'ok'); assert.strictEqual(r.findings.valid, true); assert(/KOLEJE/.test(r.findings.name)); assert(/^\d{4}-\d\d-\d\d$/.test(r.source_as_of));
  });
});
test('VIES: MS_UNAVAILABLE - це unavailable, а не fail', function () {
  return sources.vies({ country: 'PL', vat_number: '1' }, { fetch: fakeFetch({ vies: '{"isValid":false,"userError":"MS_UNAVAILABLE"}' }), now: function () { return new Date(); } }).then(function (r) {
    assert.strictEqual(r.outcome, 'unavailable'); assert.strictEqual(r.reason_code, 'VIES_MS_UNAVAILABLE');
  });
});
test('Biała lista: знімок рахунків хешується, самі номери не потрапляють у findings', function () {
  return sources.bialaLista({ nip: '5250000251' }, { fetch: fakeFetch(OK), now: function () { return new Date(); }, sha256: require('crypto').createHash ? function (x) { return require('crypto').createHash('sha256').update(x).digest('hex'); } : null }).then(function (r) {
    assert.strictEqual(r.outcome, 'ok'); assert.strictEqual(r.findings.status_vat, 'Czynny'); assert(r.findings.account_count > 0);
    assert(/^[0-9a-f]{64}$/.test(r.findings.accounts_sha256)); assert.strictEqual(r.findings.krs, '0000019193');
    assert(JSON.stringify(r.findings).indexOf('101010') < 0, 'номери рахунків не у findings');
  });
});
test('Biała lista: дата запиту - за Варшавою (не майбутня)', function () {
  var seen;
  return sources.bialaLista({ nip: '5250000251' }, { fetch: function (u) { seen = u; return res(200, WL); }, now: function () { return new Date('2026-09-25T22:30:00Z'); }, sha256: function () { return 'x'.repeat(64); } }).then(function () {
    assert(/date=2026-09-26$/.test(seen), seen);
    assert.strictEqual(sources.warsawDate(new Date('2026-09-25T21:30:00Z')), '2026-09-25');
  });
});
test('Biała lista: 400 WL-103 -> unavailable з причиною відхилення', function () {
  return sources.bialaLista({ nip: '5250000251' }, { fetch: fakeFetch({ wl: function () { return res(400, '{"code":"WL-103","message":"Data nie może być datą przyszłą."}'); } }), now: function () { return new Date(); }, sha256: function () { return 'x'; } }).then(function (r) {
    assert.strictEqual(r.outcome, 'unavailable'); assert.strictEqual(r.reason_code, 'WL_REJECTED_400');
  });
});
test('KRS: розбір витягу, stanZDnia -> source_as_of', function () {
  return sources.krs({ krs: '19193' }, { fetch: fakeFetch(OK), now: function () { return new Date(); } }).then(function (r) {
    assert.strictEqual(r.outcome, 'ok'); assert.strictEqual(r.findings.krs, '0000019193'); assert.strictEqual(r.findings.nip, '5250000251');
    assert.strictEqual(r.source_as_of, '2026-08-27'); assert.deepStrictEqual(r.findings.liquidation_or_bankruptcy_sections, []);
  });
});
test('KRS: HTTP 204 - "немає в реєстрі" (not_found), не недоступність', function () {
  return sources.krs({ krs: '1' }, { fetch: fakeFetch({ krs: 204 }), now: function () { return new Date(); } }).then(function (r) {
    assert.strictEqual(r.outcome, 'not_found'); assert.strictEqual(r.reason_code, 'NOT_IN_KRS');
  });
});

/* ---------- правила рішення ---------- */
test('PL L1 на повному каталозі: не схвалюється автоматично, бо блокуючі джерела (санкції, ЄДР) без ключа', function () {
  return run(mk(OK), PKP).then(function (c) {
    assert.strictEqual(c.status, 'manual_review');
    assert.deepStrictEqual(c.blocking_unavailable.sort(), ['risk.bankruptcy', 'risk.sanctions']);
    assert.strictEqual(st(c, 'identity.registry_match_pl').status, 'pass');
    assert.strictEqual(st(c, 'identity.vat_active').status, 'pass');
    assert.strictEqual(st(c, 'identity.registry_match').status, 'not_applicable');
    assert.strictEqual(st(c, 'risk.sanctions').status, 'unavailable'); assert.strictEqual(st(c, 'risk.sanctions').reason_code, 'NO_API_KEY');
    assert.strictEqual(st(c, 'identity.email_domain').status, 'unavailable');
    assert.strictEqual(c.expires_at, null); assert.strictEqual(c.decided_at, null);
  });
});
test('unavailable ніколи не дорівнює pass: рівень не видається, findings порожні', function () {
  return run(mk(OK), PKP).then(function (c) {
    c.results.filter(function (r) { return r.status === 'unavailable'; }).forEach(function (r) {
      assert.deepStrictEqual(r.findings, {}); assert(r.reason_code, r.check_id);
    });
    var eng = mk(OK); var r2 = eng.createCase(PKP);
    return r2.done.then(function () { assert.strictEqual(eng.levelOf(r2.case.id), 'L0'); });
  });
});
test('автосхвалення на каталозі з трьох живих джерел: L1 на 365 днів', function () {
  return run(mk(OK, { catalogs: LIGHT }), PKP).then(function (c) {
    assert.strictEqual(c.status, 'approved'); assert.deepStrictEqual(c.blocking_unavailable, []);
    var days = Math.round((new Date(c.expires_at) - new Date(c.decided_at)) / 86400000); assert.strictEqual(days, 365);
    c.results.filter(function (r) { return r.status === 'pass'; }).forEach(function (r) { assert(new Date(r.valid_until) > new Date(), 'valid_until у майбутньому'); assert(r.evidence); });
  });
});
test('KRS 204 на рішучій перевірці: fail і відмова', function () {
  return run(mk({ vies: VIES, wl: WL, krs: 204 }, { catalogs: LIGHT }), PKP).then(function (c) {
    assert.strictEqual(st(c, 'identity.registry_match_pl').status, 'fail'); assert.strictEqual(c.status, 'rejected');
    assert(/NOT_IN_KRS/.test(c.decision_reason)); assert(c.decided_at);
  });
});
test('назва не збігається з KRS: fail; частковий збіг: attention і ручний розгляд', function () {
  var bad = Object.assign({}, PKP, { declared_name: 'Zupełnie Inna Firma Sp. z o.o.' });
  var part = Object.assign({}, PKP, { declared_name: 'Polskie Koleje Logistyka' });
  return run(mk(OK, { catalogs: LIGHT }), bad).then(function (c) {
    assert.strictEqual(st(c, 'identity.registry_match_pl').reason_code, 'NAME_MISMATCH'); assert.strictEqual(c.status, 'rejected');
    return run(mk(OK, { catalogs: LIGHT }), part);
  }).then(function (c) {
    assert.strictEqual(st(c, 'identity.registry_match_pl').status, 'attention'); assert.strictEqual(c.status, 'manual_review');
  });
});
test('подібність назв: скорочення S.A. = SPÓŁKA AKCYJNA, а різні компанії зі схожою назвою нижче порогу збігу', function () {
  assert(engineMod.nameSimilarity('PKP Cargo S.A.', 'Polskie Koleje Państwowe SA') < 0.6);
  assert.strictEqual(engineMod.nameSimilarity('Polskie Koleje Państwowe S.A.', 'POLSKIE KOLEJE PAŃSTWOWE SPÓŁKA AKCYJNA'), 1);
});
test('VIES недоступний: 3 спроби, unavailable без знахідок, справа не блокується (джерело не блокуюче)', function () {
  var calls = [];
  var eng = engineMod.createEngine({ fetch: fakeFetch({ vies: '{"isValid":false,"userError":"MS_UNAVAILABLE"}', wl: WL, krs: KRS }, calls), sleep: noSleep, env: {}, cacheMs: 0, catalogs: LIGHT });
  return run(eng, PKP).then(function (c) {
    var v = st(c, 'identity.vat_active');
    assert.strictEqual(v.status, 'unavailable'); assert.strictEqual(v.attempt, 3); assert.deepStrictEqual(v.findings, {});
    assert.strictEqual(calls.filter(function (u) { return /vies/.test(u); }).length, 3);
    assert.strictEqual(c.status, 'approved', 'за розділом 5 недоступне неблокуюче джерело не забороняє рівень');
  });
});
test('позаєвропейський суб’єкт: VIES і KRS не застосовні', function () {
  return run(mk(OK), { target_level: 'L1', identifiers: [{ kind: 'edrpou', value: '12345678', country: 'UA' }] }).then(function (c) {
    assert.strictEqual(st(c, 'identity.vat_active').status, 'not_applicable'); assert.strictEqual(st(c, 'identity.registry_match_pl').status, 'not_applicable');
    assert.strictEqual(st(c, 'identity.registry_match').status, 'unavailable'); assert.strictEqual(st(c, 'risk.sanctions_ua').reason_code, 'NO_API_KEY');
    assert.strictEqual(c.status, 'manual_review');
  });
});
test('докази: SHA-256 збігається з сирим відгуком, читання за хешем повертає ті самі байти', function () {
  var eng = mk(OK, { catalogs: LIGHT });
  return run(eng, PKP).then(function (c) {
    var r = st(c, 'identity.registry_match_pl');
    var sha = require('crypto').createHash('sha256').update(KRS).digest('hex');
    assert.strictEqual(r.evidence.payload_sha256, sha); assert.strictEqual(r.evidence.source_as_of, '2026-08-27');
    assert.strictEqual(eng.readEvidence(sha).toString('utf8'), KRS);
    assert(/^\d{4}-\d\d-\d\d$/.test(r.evidence.retention_until));
    assert(new Date(r.evidence.retention_until) - new Date(r.evidence.fetched_at) > 4.9 * 365 * 86400000);
  });
});
test('ідемпотентність і конфлікт активної справи', function () {
  var eng = mk(OK);
  var a = eng.createCase(Object.assign({ idempotency_key: 'idem-key-0001' }, PKP));
  var b = eng.createCase(Object.assign({ idempotency_key: 'idem-key-0001' }, PKP));
  assert.strictEqual(a.case.id, b.case.id); assert.strictEqual(b.replay, true);
  return a.done.then(function () {
    assert.throws(function () { eng.createCase(Object.assign({ idempotency_key: 'idem-key-0002' }, PKP)); }, function (e) { return e.status === 409; });
  });
});
test('валідація входу: 422', function () {
  var eng = mk(OK);
  assert.throws(function () { eng.createCase({ target_level: 'L9', identifiers: [] }); }, function (e) { return e.status === 422; });
  assert.throws(function () { eng.createCase({ target_level: 'L1', identifiers: [{ kind: 'nip', value: '1', country: 'pl' }] }); }, function (e) { return e.status === 422; });
});

/* ---------- рішення оператора ---------- */
test('схвалення попри блокуючі джерела: без override - 409; з override - строк удвічі коротший і окрема подія', function () {
  var eng = mk(OK);
  var r = eng.createCase(PKP);
  return r.done.then(function () {
    assert.throws(function () { eng.decide(r.case.id, { decision: 'approve', reason: 'Перевірено вручну за паперами' }); }, function (e) { return e.status === 409; });
    var c = eng.decide(r.case.id, { decision: 'approve', reason: 'Перевірено вручну за паперами', override_blocking: true });
    assert.strictEqual(c.status, 'approved');
    var days = Math.round((new Date(c.expires_at) - new Date(c.decided_at)) / 86400000); assert.strictEqual(days, 182);
    var ev = eng.events(r.case.id).filter(function (e) { return e.type === 'override_blocking'; });
    assert.strictEqual(ev.length, 1); assert.deepStrictEqual(ev[0].detail.blocking_unavailable.sort(), ['risk.bankruptcy', 'risk.sanctions']);
    assert.strictEqual(eng.levelOf(r.case.id), 'L1');
  });
});
test('схвалення справи з fail неможливе навіть з override', function () {
  var eng = mk({ vies: VIES, wl: WL, krs: 204 });
  var r = eng.createCase(PKP);
  return r.done.then(function () {
    assert.strictEqual(eng.getCase(r.case.id).status, 'rejected');
    assert.throws(function () { eng.decide(r.case.id, { decision: 'approve', reason: 'Хочу схвалити попри відмову', override_blocking: true }); }, function (e) { return e.status === 409; });
  });
});
test('строк дії рівня: після закінчення компанія падає на L0', function () {
  var t = new Date('2026-09-26T10:00:00Z');
  var eng = engineMod.createEngine({ fetch: fakeFetch(OK), sleep: noSleep, env: {}, cacheMs: 0, catalogs: LIGHT, now: function () { return new Date(t.getTime()); } });
  var r = eng.createCase(PKP);
  return r.done.then(function () {
    assert.strictEqual(eng.levelOf(r.case.id), 'L1');
    t = new Date(t.getTime() + 366 * 86400000);
    assert.strictEqual(eng.levelOf(r.case.id), 'L0');
  });
});

/* ---------- HTTP ---------- */
function call(port, method, p, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({ port: port, method: method, path: p, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, function (r) {
      var chunks = []; r.on('data', function (c) { chunks.push(c); });
      r.on('end', function () { var t = Buffer.concat(chunks).toString('utf8'); var j; try { j = JSON.parse(t); } catch (e) { j = null; } resolve({ status: r.statusCode, json: j, text: t, headers: r.headers }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
function poll(port, id) {
  return call(port, 'GET', '/api/verification/cases/' + id).then(function (r) {
    if (r.json.status !== 'running') return r;
    return new Promise(function (ok) { setTimeout(ok, 20); }).then(function () { return poll(port, id); });
  });
}
test('HTTP: створення справи, опитування, докази, рішення оператора', function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-verif-'));
  var api = verificationApi.create({ engine: mk(OK, { dir: dir }), env: { VERIFICATION_OPERATOR_TOKEN: 'secret-op-token' } });
  var helpers = {
    sendJson: function (res, status, body) { var t = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(t) }); res.end(t); },
    readJsonBody: function (req) { return new Promise(function (ok, no) { var c = []; req.on('data', function (x) { c.push(x); }); req.on('end', function () { try { ok(c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}); } catch (e) { no(new Error('invalid_json')); } }); }); }
  };
  var server = http.createServer(function (req, res) { if (!api.handle(req, res, require('url').parse(req.url, true), helpers)) { res.writeHead(404); res.end(); } });
  return new Promise(function (ok) { server.listen(0, ok); }).then(function () {
    var port = server.address().port, caseId;
    return call(port, 'GET', '/api/verification/sources').then(function (r) {
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.items.length, 13);
      assert.deepStrictEqual(r.json.items.filter(function (s) { return s.state === 'live'; }).map(function (s) { return s.id; }).sort(), ['pl_krs', 'pl_white_list', 'vies']);
      return call(port, 'POST', '/api/verification/cases', PKP);
    }).then(function (r) {
      assert.strictEqual(r.status, 422, 'без Idempotency-Key');
      return call(port, 'POST', '/api/verification/cases', PKP, { 'Idempotency-Key': 'http-idem-0001' });
    }).then(function (r) {
      assert.strictEqual(r.status, 201); caseId = r.json.id; assert.strictEqual(r.json.status, 'running');
      return poll(port, caseId);
    }).then(function (r) {
      assert.strictEqual(r.json.status, 'manual_review'); assert.strictEqual(r.json.level, 'L0');
      var kr = r.json.results.filter(function (x) { return x.check_id === 'identity.registry_match_pl'; })[0];
      return call(port, 'GET', '/api/verification/checks/' + kr.id + '/evidence').then(function (e) {
        assert.strictEqual(e.status, 200); assert.strictEqual(e.json.payload_sha256, kr.evidence.payload_sha256);
        return call(port, 'GET', e.json.download_url);
      }).then(function (raw) {
        assert.strictEqual(raw.status, 200); assert.strictEqual(raw.text, KRS);
        return call(port, 'POST', '/api/verification/cases/' + caseId + '/decision', { decision: 'approve', reason: 'Перевірено вручну за паперами', override_blocking: true });
      });
    }).then(function (r) {
      assert.strictEqual(r.status, 403, 'без токена оператора');
      return call(port, 'POST', '/api/verification/cases/' + caseId + '/decision', { decision: 'approve', reason: 'Перевірено вручну за паперами', override_blocking: true }, { 'x-operator-token': 'secret-op-token' });
    }).then(function (r) {
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.status, 'approved');
      return call(port, 'POST', '/api/verification/cases', PKP, { 'Idempotency-Key': 'http-idem-0002' });
    }).then(function (r) {
      assert.strictEqual(r.status, 201, 'після схвалення нова справа дозволена');
      return call(port, 'GET', '/api/verification/cases/00000000-0000-4000-8000-000000000000');
    }).then(function (r) { assert.strictEqual(r.status, 404); }).then(function () { server.close(); }, function (e) { server.close(); throw e; });
  });
});
test('HTTP: рішення вимкнено, доки не задано токен оператора', function () {
  var api = verificationApi.create({ engine: mk(OK), env: {} });
  var sent = {};
  var res_ = { writeHead: function (s) { sent.status = s; }, end: function () { sent.done = true; } };
  var handled = api.handle({ method: 'POST', headers: {} }, res_, { pathname: '/api/verification/cases/00000000-0000-4000-8000-000000000000/decision' }, { sendJson: function () {}, readJsonBody: function () { return Promise.resolve({}); } });
  assert.strictEqual(handled, true); assert.strictEqual(sent.status, 403);
});

if (process.argv.indexOf('--live') >= 0) {
  test('LIVE: PKP S.A. по трьох справжніх джерелах', function () {
    var eng = engineMod.createEngine({ env: {}, cacheMs: 0 });
    return run(eng, PKP).then(function (c) {
      console.log('    live: ' + c.status + ' | ' + c.results.map(function (r) { return r.check_id + '=' + r.status + (r.reason_code ? '(' + r.reason_code + ')' : ''); }).join(', '));
      ['identity.vat_active', 'identity.registry_match_pl'].forEach(function (id) { assert.strictEqual(st(c, id).status, 'pass', id); });
    });
  });
}

queue.reduce(function (chain, t) {
  return chain.then(function () {
    return Promise.resolve().then(t.f).then(function () { passed++; console.log('  ok   ' + t.n); }, function (e) { failed++; console.log('  FAIL ' + t.n + '\n       ' + (e && e.message)); });
  });
}, Promise.resolve()).then(function () {
  console.log('\n' + passed + ' із ' + (passed + failed) + ' тестів пройдено');
  process.exit(failed ? 1 : 0);
});
