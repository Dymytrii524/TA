'use strict';
/**
 * Читальний зріз /api/v1 (sprint-0-backend/api/openapi.yaml), що працює на файлі, а не на PostgreSQL:
 *   GET /api/v1/health
 *   GET /api/v1/listings            фільтри, сортування й курсор за контрактом
 *   GET /api/v1/listings/{id}
 *   GET /api/v1/reference/{cities,cargo-types,currencies}
 * Решта шляхів контракту (auth, публікація, контакти, події) повертає 501 problem+json:
 * реалізовано лише читання. Дані - server/data/listings.canonical.json, який пише
 * sprint-0-backend/tools/export_canonical.py тими самими функціями, що й імпортер у БД.
 * Health чесно каже db=down і redis=down: ні бази, ні Redis тут немає.
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var SEED = path.join(ROOT, 'sprint-0-backend', 'seed');
var DEFAULT_DATA = path.join(__dirname, '..', 'data', 'listings.canonical.json');
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

var MODES = ['auto', 'rail', 'sea', 'air', 'multi', 'drone'];
var SORTS = { created_desc: 1, date_asc: 1, price_desc: 1 };
var NOT_IMPLEMENTED = [/^\/api\/v1\/auth\//, /^\/api\/v1\/companies\//, /^\/api\/v1\/events$/, /^\/api\/v1\/listings\/[^/]+\/contact$/];

function problem(status, title, detail, errors) {
  var p = { type: 'about:blank', title: title, status: status };
  if (detail) p.detail = detail;
  if (errors) p.errors = errors;
  return p;
}

function create(opts) {
  opts = opts || {};
  var dataFile = opts.dataFile || DEFAULT_DATA;
  var rows = opts.rows || null;
  var byId = null;
  var loadError = null;

  function load() {
    if (rows) return true;
    if (loadError) return false;
    try {
      rows = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      return true;
    } catch (e) {
      loadError = e.code === 'ENOENT'
        ? 'Немає ' + path.relative(ROOT, dataFile) + ': виконайте python sprint-0-backend/tools/export_canonical.py'
        : 'Не вдалося прочитати ' + path.relative(ROOT, dataFile) + ': ' + e.message;
      return false;
    }
  }
  function index() {
    if (byId) return byId;
    byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    return byId;
  }
  function seed(name) { return JSON.parse(fs.readFileSync(path.join(SEED, name), 'utf8')); }

  function validate(q) {
    var errs = [];
    function bad(name, code, message) { errs.push({ pointer: '/query/' + name, code: code, message: message }); }
    if (q.kind !== undefined && ['cargo', 'transport'].indexOf(q.kind) < 0) bad('kind', 'enum', 'cargo | transport');
    if (q.mode !== undefined && MODES.indexOf(q.mode) < 0) bad('mode', 'enum', MODES.join(' | '));
    if (q.border_scope !== undefined && ['international', 'domestic'].indexOf(q.border_scope) < 0) bad('border_scope', 'enum', 'international | domestic');
    if (q.status !== undefined && ['active', 'paused', 'expired', 'closed'].indexOf(q.status) < 0) bad('status', 'enum', 'active | paused | expired | closed');
    if (q.sort !== undefined && !SORTS[q.sort]) bad('sort', 'enum', Object.keys(SORTS).join(' | '));
    ['origin_country', 'destination_country'].forEach(function (k) { if (q[k] !== undefined && !/^[A-Z]{2}$/.test(q[k])) bad(k, 'pattern', 'два великі літери'); });
    if (q.currency !== undefined && !/^[A-Z]{3,4}$/.test(q.currency)) bad('currency', 'pattern', '3–4 великі літери');
    ['date_from', 'date_to'].forEach(function (k) { if (q[k] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(q[k])) bad(k, 'format', 'YYYY-MM-DD'); });
    if (q.company_id !== undefined && !UUID.test(q.company_id)) bad('company_id', 'format', 'uuid');
    if (q.limit !== undefined && !(/^\d+$/.test(q.limit) && +q.limit >= 1 && +q.limit <= 100)) bad('limit', 'range', '1–100');
    if (q.components !== undefined && q.components.split(',').some(function (c) { return ['auto', 'rail', 'sea', 'air'].indexOf(c) < 0; })) bad('components', 'enum', 'auto | rail | sea | air');
    if (q.cursor !== undefined && !/^o:\d+$/.test(Buffer.from(String(q.cursor), 'base64url').toString('utf8'))) bad('cursor', 'format', 'непридатний курсор');
    return errs;
  }

  /** Той самий набір умов, що й filteredListings() у SPA (index.html), у термінах канонічних полів. */
  function matches(r, q) {
    if (r.status !== (q.status || 'active')) return false;
    if (q.kind && r.kind !== q.kind) return false;
    if (q.mode && r.mode !== q.mode) return false;
    if (q.mode === 'multi' && q.components) {
      var want = q.components.split(',');
      var have = r.components || [];
      if (!want.some(function (c) { return have.indexOf(c) > -1; })) return false;
    }
    if (q.origin_city_id && r.origin_city_id !== q.origin_city_id) return false;
    if (q.destination_city_id && r.destination_city_id !== q.destination_city_id) return false;
    if (q.origin_country && r.origin_country !== q.origin_country) return false;
    if (q.destination_country && r.destination_country !== q.destination_country) return false;
    if (q.border_scope === 'international' && !r.is_cross_border) return false;
    if (q.border_scope === 'domestic' && r.is_cross_border) return false;
    if (q.currency && r.price_currency !== q.currency) return false;
    if (q.cargo_type_id && r.cargo_type_id !== q.cargo_type_id) return false;
    if (q.date_from && r.ready_date < q.date_from) return false;
    if (q.date_to && r.ready_date > q.date_to) return false;
    if (q.company_id && r.company.id !== q.company_id) return false;
    return true;
  }

  function cmp(sort) {
    return function (a, b) {
      var d = 0;
      if (sort === 'date_asc') d = a.ready_date < b.ready_date ? -1 : a.ready_date > b.ready_date ? 1 : 0;
      else if (sort === 'price_desc') d = Number(b.price_amount) - Number(a.price_amount);
      else d = a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
      if (d) return d;
      return (a.legacy_id || 0) - (b.legacy_id || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    };
  }

  function listings(q) {
    var errs = validate(q);
    if (errs.length) return { status: 422, body: problem(422, 'Параметри не пройшли валідацію', null, errs) };
    var limit = q.limit ? +q.limit : 30;
    var offset = q.cursor ? +Buffer.from(q.cursor, 'base64url').toString('utf8').slice(2) : 0;
    var all = rows.filter(function (r) { return matches(r, q); }).sort(cmp(q.sort || 'created_desc'));
    var items = all.slice(offset, offset + limit);
    var hasMore = offset + limit < all.length;
    return { status: 200, body: { items: items, page: { limit: limit, next_cursor: hasMore ? Buffer.from('o:' + (offset + limit)).toString('base64url') : null, has_more: hasMore, total_matching: all.length } } };
  }

  /** Повертає true, якщо шлях належить /api/v1. */
  function handle(req, res, parsed, sendJson) {
    var p = parsed.pathname;
    if (p.indexOf('/api/v1/') !== 0 && p !== '/api/v1') return false;
    function send(status, body) {
      if (status >= 400) {
        var t = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/problem+json; charset=utf-8', 'Content-Length': Buffer.byteLength(t), 'Access-Control-Allow-Origin': '*' });
        res.end(t);
      } else sendJson(res, status, body);
    }
    if (p === '/api/v1/health' && req.method === 'GET') {
      var ok = load();
      send(200, { status: 'degraded', db: 'down', redis: 'down', version: 'sprint0-readonly-file', time: new Date().toISOString(),
        storage: ok ? 'file' : 'unavailable', listings_loaded: ok ? rows.length : 0, detail: ok ? 'PostgreSQL і Redis не розгорнуто: читання з файлу' : loadError });
      return true;
    }
    if (NOT_IMPLEMENTED.some(function (re) { return re.test(p); }) || (req.method !== 'GET' && /^\/api\/v1\/(listings|reference)/.test(p))) {
      send(501, problem(501, 'Не реалізовано', 'Реалізовано лише читання: GET /api/v1/health, /listings, /listings/{id}, /reference/*'));
      return true;
    }
    if (req.method !== 'GET') { send(405, problem(405, 'Метод не дозволено')); return true; }
    var m;
    if (p === '/api/v1/reference/cities') {
      var country = parsed.query.country, cont = parsed.query.continent;
      send(200, { items: seed('cities.json').filter(function (c) { return (!country || c.country === country) && (!cont || c.continent === cont); }).map(function (c) {
        return { id: c.id, country: c.country, continent: c.continent, lat: c.lat, lon: c.lon, icao: c.icao || null, names: { uk: c.name_uk, en: c.name_en, pl: c.name_pl, de: c.name_de } };
      }) });
      return true;
    }
    if (p === '/api/v1/reference/cargo-types') {
      send(200, { items: seed('cargo_types.json').map(function (c) { return { id: c.id, names: { uk: c.name_uk, en: c.name_en, pl: c.name_pl, de: c.name_de } }; }) });
      return true;
    }
    if (p === '/api/v1/reference/currencies') { send(200, { items: seed('currencies.json') }); return true; }
    if (p === '/api/v1/listings' || (m = /^\/api\/v1\/listings\/([^/]+)$/.exec(p))) {
      if (!load()) { send(503, problem(503, 'Набір заявок недоступний', loadError)); return true; }
      if (m) {
        if (!UUID.test(m[1])) { send(422, problem(422, 'Параметри не пройшли валідацію', null, [{ pointer: '/path/id', code: 'format', message: 'uuid' }])); return true; }
        var one = index()[m[1]];
        if (!one) { send(404, problem(404, 'Заявку не знайдено')); return true; }
        send(200, one); return true;
      }
      var r = listings(parsed.query);
      send(r.status, r.body); return true;
    }
    send(404, problem(404, 'Шлях не існує в контракті'));
    return true;
  }

  return { handle: handle, listings: function (q) { load(); return listings(q); } };
}

module.exports = { create: create };
