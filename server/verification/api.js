'use strict';
/**
 * HTTP-шар модуля верифікації (підмножина sprint-0-backend/api/openapi-verification.yaml):
 *   GET  /api/verification/sources
 *   POST /api/verification/cases                         (заголовок Idempotency-Key обов'язковий)
 *   GET  /api/verification/cases/{id}
 *   GET  /api/verification/cases/{id}/events             (додатково до OpenAPI: журнал подій справи)
 *   POST /api/verification/cases/{id}/decision           (лише з VERIFICATION_OPERATOR_TOKEN у x-operator-token)
 *   GET  /api/verification/checks/{result_id}/evidence
 *   GET  /api/verification/evidence/{sha256}             (сирий відгук джерела)
 *
 * Ролей і автентифікації немає. Рішення оператора вимкнено, доки не задано
 * VERIFICATION_OPERATOR_TOKEN, а не відкрито всім. Читання справи за uuid не захищене:
 * це демонстрація, а не сервіс із персональними даними.
 */

var path = require('path');
var engineMod = require('./engine');

var UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function create(opts) {
  opts = opts || {};
  var engine = opts.engine || engineMod.createEngine({ dir: opts.dir || path.join(__dirname, '..', '.verification-store') });
  var env = opts.env || process.env;

  function sendProblem(res, sendJson, err) {
    var p = err.problem || { type: 'about:blank', title: 'Внутрішня помилка', status: 500 };
    var text = JSON.stringify(p);
    res.writeHead(p.status, { 'Content-Type': 'application/problem+json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Access-Control-Allow-Origin': '*' });
    res.end(text);
  }

  /** Повертає true, якщо запит належить модулю верифікації. */
  function handle(req, res, parsed, helpers) {
    var p = parsed.pathname;
    if (p.indexOf('/api/verification/') !== 0) return false;
    var sendJson = helpers.sendJson;
    function fail(err) {
      if (err && (err.message === 'invalid_json' || err.message === 'payload_too_large')) err = { problem: { type: 'about:blank', title: 'Некоректне тіло запиту', status: 400, detail: err.message } };
      if (!err.problem) { console.error('[verification]', err); err = { problem: { type: 'about:blank', title: 'Внутрішня помилка', status: 500 } }; }
      sendProblem(res, sendJson, err);
    }
    var m;
    try {
      if (req.method === 'GET' && p === '/api/verification/sources') {
        sendJson(res, 200, { items: engine.listSources() }); return true;
      }
      if (req.method === 'POST' && p === '/api/verification/cases') {
        helpers.readJsonBody(req).then(function (body) {
          var key = req.headers['idempotency-key'];
          if (!key || key.length < 8 || key.length > 128) throw Object.assign(new Error('idem'), { status: 422, problem: { type: 'about:blank', title: 'Потрібен заголовок Idempotency-Key (8–128 символів)', status: 422 } });
          body.idempotency_key = key;
          var r = engine.createCase(body);
          sendJson(res, r.replay ? 200 : 201, engine.getCase(r.case.id));
        }).catch(fail);
        return true;
      }
      if ((m = new RegExp('^/api/verification/cases/(' + UUID + ')$').exec(p)) && req.method === 'GET') {
        var c = engine.getCase(m[1]);
        if (!c) return fail({ problem: { type: 'about:blank', title: 'Справу не знайдено', status: 404 } }), true;
        c.level = engine.levelOf(m[1]);
        sendJson(res, 200, c); return true;
      }
      if ((m = new RegExp('^/api/verification/cases/(' + UUID + ')/events$').exec(p)) && req.method === 'GET') {
        sendJson(res, 200, { items: engine.events(m[1]) }); return true;
      }
      if ((m = new RegExp('^/api/verification/cases/(' + UUID + ')/decision$').exec(p)) && req.method === 'POST') {
        var token = env.VERIFICATION_OPERATOR_TOKEN;
        if (!token) return fail({ problem: { type: 'about:blank', title: 'Рішення оператора вимкнено', status: 403, detail: 'VERIFICATION_OPERATOR_TOKEN не задано на сервері' } }), true;
        if (req.headers['x-operator-token'] !== token) return fail({ problem: { type: 'about:blank', title: 'Потрібна роль оператора верифікації', status: 403 } }), true;
        helpers.readJsonBody(req).then(function (body) { sendJson(res, 200, engine.decide(m[1], body)); }).catch(fail);
        return true;
      }
      if ((m = new RegExp('^/api/verification/checks/(' + UUID + ')/evidence$').exec(p)) && req.method === 'GET') {
        var ev = engine.evidenceOf(m[1]);
        if (!ev) return fail({ problem: { type: 'about:blank', title: 'Доказ не знайдено', status: 404 } }), true;
        sendJson(res, 200, { payload_sha256: ev.payload_sha256, content_type: ev.content_type, fetched_at: ev.fetched_at, source_as_of: ev.source_as_of,
          download_url: '/api/verification/evidence/' + ev.payload_sha256, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        return true;
      }
      if ((m = /^\/api\/verification\/evidence\/([0-9a-f]{64})$/.exec(p)) && req.method === 'GET') {
        var buf = engine.readEvidence(m[1]);
        if (!buf) return fail({ problem: { type: 'about:blank', title: 'Доказ не знайдено', status: 404 } }), true;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'X-Content-SHA256': m[1], 'Access-Control-Allow-Origin': '*' });
        res.end(buf); return true;
      }
    } catch (err) { fail(err); return true; }
    sendJson(res, 404, { error: 'not_found' });
    return true;
  }
  return { handle: handle, engine: engine };
}

module.exports = { create: create };
