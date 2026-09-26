'use strict';
/**
 * Машина справи верифікації (ТЗ sprint-0-backend/ТЗ-верифікація-контрагентів.md, розділи 2, 3, 5, 9).
 *
 * Що працює по-справжньому: три живі джерела (VIES, Biała lista, KRS), правила ухвалення
 * рішення з розділу 5, докази з SHA-256, строки дії рівня, override_blocking із скороченням
 * строку вдвічі та окремою подією в журналі. Результати відповідають
 * sprint-0-backend/schemas/verification.schema.json (перевіряється тестом на живій схемі).
 *
 * Чого тут немає: сховища WORM (докази пишуться в локальні файли з прапором wx - запис один раз
 * на рівні застосунку, а не гарантія сховища), ролей і автентифікації, бази PostgreSQL,
 * джерел, що потребують ключа/договору (ЄДР, РНБО, OpenSanctions, ЄДРСР, агрегатор) - вони
 * чесно повертають unavailable з кодом NO_API_KEY, а не вигадані дані.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var sources = require('./sources');

var ROOT = path.join(__dirname, '..', '..');
var SEED = path.join(ROOT, 'sprint-0-backend', 'seed');
var DAY = 24 * 3600 * 1000;
var LEVEL_DAYS = { L1: 365, L2: 180 };
var RETENTION_YEARS = 5;

var KEY_ENV = { edr_nais: 'EDR_NAIS_API_KEY', drs_nsdc: 'DRS_NSDC_API_KEY', opensanctions: 'OPENSANCTIONS_API_KEY',
  edrsr: 'EDRSR_API_KEY', opendatabot: 'OPENDATABOT_API_KEY', youcontrol: 'YOUCONTROL_API_KEY' };
var MANUAL = { control_payment: 1, erru: 1, domain_email: 1 };
var LIVE = { vies: 1, pl_white_list: 1, pl_krs: 1 };
var EU = { AT:1, BE:1, BG:1, HR:1, CY:1, CZ:1, DK:1, EE:1, FI:1, FR:1, DE:1, GR:1, HU:1, IE:1, IT:1, LV:1, LT:1, LU:1, MT:1, NL:1, PL:1, PT:1, RO:1, SK:1, SI:1, ES:1, SE:1 };
var STOP = { SPOLKA:1, AKCYJNA:1, SP:1, Z:1, O:1, OO:1, ZOO:1, SA:1, LTD:1, GMBH:1, LLC:1, INC:1, TOW:1, TOV:1, THE:1, ODPOWIEDZIALNOSCIA:1, OGRANICZONA:1 };

function readSeed(name) { return JSON.parse(fs.readFileSync(path.join(SEED, name), 'utf8')); }

function sha256(x) { return crypto.createHash('sha256').update(x).digest('hex'); }

function uuidFrom(str) {
  var h = crypto.createHash('sha1').update(str).digest('hex');
  var v = ((parseInt(h.substr(16, 2), 16) & 0x3f) | 0x80).toString(16);
  return h.substr(0, 8) + '-' + h.substr(8, 4) + '-5' + h.substr(13, 3) + '-' + v + h.substr(18, 2) + '-' + h.substr(20, 12);
}

function normName(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/Ł/g, 'L')
    .replace(/[^A-Z0-9А-ЯІЇЄҐ ]+/g, ' ').split(/\s+/).filter(function (t) { return t.length > 1 && !STOP[t]; });
}
/** Частка спільних значущих слів (Jaccard). Гіпотеза для оператора, не вирок (ТЗ, розділ 5). */
function nameSimilarity(a, b) {
  var A = normName(a), B = normName(b);
  if (!A.length || !B.length) return 0;
  var inter = A.filter(function (t) { return B.indexOf(t) >= 0; }).length;
  return inter / (A.length + B.length - inter);
}

function problem(status, title, detail) {
  var e = new Error(title); e.status = status; e.problem = { type: 'about:blank', title: title, status: status, detail: detail || title };
  return e;
}

function createEngine(opts) {
  opts = opts || {};
  var now = opts.now || function () { return new Date(); };
  var env = opts.env || process.env;
  var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var deps = { fetch: opts.fetch || fetch, now: now, sha256: sha256, timeoutMs: opts.timeoutMs, userAgent: opts.userAgent };
  var cacheMs = opts.cacheMs === undefined ? 10 * 60 * 1000 : opts.cacheMs;
  var dir = opts.dir || null;

  // opts.catalogs - лише для тестів правил рішення на урізаному каталозі
  var srcList = opts.catalogs ? opts.catalogs.sources : readSeed('verification_sources.json');
  var chkList = opts.catalogs ? opts.catalogs.checks : readSeed('verification_checks.json');
  var SRC = {}; srcList.forEach(function (s) { SRC[s.id] = s; });

  var store = { cases: {}, events: [], idem: {}, resultToCase: {} };
  var cache = {};
  var evidenceMem = {};
  if (dir) {
    fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
    var f = path.join(dir, 'store.json');
    if (fs.existsSync(f)) { try { store = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* пошкоджений файл: стартуємо з порожнього стану */ } }
  }
  function persist() { if (dir) fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(store)); }
  function event(caseId, type, detail) {
    store.events.push({ at: now().toISOString(), case_id: caseId, type: type, detail: detail || {} });
  }

  function saveEvidence(raw) {
    var sha = sha256(raw);
    var buf = Buffer.from(raw, 'utf8');
    if (dir) {
      try { fs.writeFileSync(path.join(dir, 'evidence', sha), buf, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } else { evidenceMem[sha] = buf; }
    return { sha: sha, size: buf.length };
  }
  function readEvidence(sha) {
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    if (dir) { var p = path.join(dir, 'evidence', sha); return fs.existsSync(p) ? fs.readFileSync(p) : null; }
    return evidenceMem[sha] || null;
  }

  function sourceState(id) {
    if (LIVE[id]) return 'live';
    if (id === 'dsbt_licenses') return 'stale';
    if (MANUAL[id]) return 'manual_only';
    return 'needs_key';
  }
  function listSources() {
    return srcList.map(function (s) {
      var st = sourceState(s.id);
      return { id: s.id, title: s.title, kind: s.kind, jurisdiction: s.jurisdiction, requires_key: s.requires_key, blocking: s.blocking,
        ttl_days: s.ttl_days, docs_url: s.docs_url || null, state: st,
        connector: LIVE[s.id] ? 'implemented' : (st === 'needs_key' && env[KEY_ENV[s.id]] ? 'key_present_connector_missing' : 'not_implemented') };
    });
  }

  /* ---------- виконання перевірок ---------- */
  function transient(code) { return /NETWORK|_HTTP_5\d\d|MS_UNAVAILABLE|TIMEOUT|MAX_CONCURRENT/.test(code || ''); }

  function callSource(sourceId, fn, subject, keyStr) {
    var ck = sourceId + '|' + keyStr;
    var hit = cache[ck];
    if (hit && cacheMs && now().getTime() - hit.at < cacheMs && hit.res.outcome !== 'unavailable') return Promise.resolve(hit.res);
    var attempts = 0;
    function go() {
      attempts++;
      var t0 = Date.now();
      return fn(subject, deps).then(function (res) {
        res.latency_ms = Date.now() - t0;
        if (res.outcome === 'unavailable' && transient(res.reason_code) && attempts < 3) {
          return sleep(200 * Math.pow(3, attempts - 1)).then(go);
        }
        res.attempt = attempts;
        res.fetched_at = now().toISOString();
        if (res.outcome !== 'unavailable') cache[ck] = { at: now().getTime(), res: res };
        return res;
      });
    }
    return go();
  }

  function subjectOf(input) {
    var s = { country: input.country, name: input.declared_name || null, nip: null, vat_number: null, krs: null, email: input.email || null, edrpou: null };
    input.identifiers.forEach(function (i) {
      var v = String(i.value).replace(/[\s-]/g, '');
      if (i.kind === 'nip') s.nip = v.replace(/^PL/i, '');
      if (i.kind === 'vat_eu') s.vat_number = v.replace(/^[A-Z]{2}/i, '');
      if (i.kind === 'krs') s.krs = v;
      if (i.kind === 'edrpou') s.edrpou = v;
    });
    if (!s.vat_number && s.nip && s.country === 'PL') s.vat_number = s.nip;
    return s;
  }
  function primaryId(s) {
    if (s.nip) return { kind: 'nip', value: s.nip };
    if (s.vat_number) return { kind: 'vat_eu', value: s.vat_number };
    if (s.krs) return { kind: 'krs', value: s.krs };
    if (s.edrpou) return { kind: 'edrpou', value: s.edrpou };
    return { kind: 'other', value: '?' };
  }

  function plus(iso, days) { return new Date(new Date(iso).getTime() + days * DAY).toISOString(); }

  /** Розбір відповіді джерела за критерієм перевірки: тут і лише тут рішення pass/fail/attention. */
  function interpret(check, src, subject, resp, ctx) {
    var out = { status: null, reason_code: null, reason_text: null, findings: resp.findings || {} };
    function pass() { out.status = 'pass'; }
    function violated(code, text) {
      out.status = check.is_decisive ? 'fail' : 'attention'; out.reason_code = code; out.reason_text = text;
    }
    if (resp.outcome === 'unavailable') {
      out.status = 'unavailable'; out.reason_code = resp.reason_code; out.reason_text = resp.reason_text; out.findings = {};
      return out;
    }
    if (check.id === 'identity.vat_active') {
      if (resp.findings.valid) pass(); else violated('VAT_INVALID', 'VIES: номер ПДВ недійсний');
    } else if (check.id === 'monitor.vat_status') {
      if (resp.outcome === 'not_found') violated('NOT_IN_WHITE_LIST', resp.reason_text);
      else if (resp.findings.status_vat === 'Czynny') pass();
      else violated('VAT_STATUS_' + String(resp.findings.status_vat || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20), 'Статус ПДВ у Biała lista: ' + resp.findings.status_vat);
    } else if (check.id === 'identity.registry_match_pl') {
      if (resp.outcome === 'not_found') violated(resp.reason_code || 'NOT_IN_KRS', resp.reason_text);
      else if (resp.findings.liquidation_or_bankruptcy_sections.length) violated('KRS_LIQUIDATION_OR_BANKRUPTCY', 'У витягу KRS є розділ ліквідації або банкрутства: ' + resp.findings.liquidation_or_bankruptcy_sections.join(', '));
      else if (subject.nip && resp.findings.nip && subject.nip !== resp.findings.nip) violated('NIP_KRS_MISMATCH', 'NIP у KRS (' + resp.findings.nip + ') не збігається з поданим');
      else if (subject.name) {
        var sim = nameSimilarity(subject.name, resp.findings.name);
        out.findings = Object.assign({}, resp.findings, { name_similarity: Math.round(sim * 100) / 100 });
        if (sim >= 0.6) pass();
        else if (sim >= 0.3) { out.status = 'attention'; out.reason_code = 'NAME_PARTIAL_MATCH'; out.reason_text = 'Назва частково збігається з KRS (' + out.findings.name_similarity + '): потрібен розгляд оператора'; }
        else violated('NAME_MISMATCH', 'Назва не збігається з KRS (' + out.findings.name_similarity + ')');
      } else pass();
    }
    return out;
  }

  function runCheck(check, subject, ctx) {
    var src = SRC[check.source_id];
    var requestedAt = now().toISOString();
    var base = { id: crypto.randomUUID(), check_id: check.id, source_id: check.source_id, requested_at: requestedAt };
    var pid = primaryId(subject);
    function done(status, reason, text, extra) {
      var r = Object.assign(base, { status: status, subject: { identifier_kind: pid.kind, identifier_value: pid.value, country: subject.country },
        findings: {}, reason_code: reason || null, reason_text: text || null, responded_at: null, valid_until: null, latency_ms: null, attempt: 1, evidence: null }, extra || {});
      if (subject.name) r.subject.name = subject.name;
      return Promise.resolve(r);
    }

    if (check.jurisdictions && check.jurisdictions.indexOf(subject.country) < 0) {
      return done('not_applicable', 'NOT_IN_JURISDICTION', 'Перевірка застосовна лише до: ' + check.jurisdictions.join(', '));
    }
    if (check.source_id === 'vies' && !EU[subject.country]) return done('not_applicable', 'NON_EU_SUBJECT', 'VIES охоплює лише країни ЄС');
    if (!LIVE[check.source_id]) {
      if (MANUAL[check.source_id]) return done('unavailable', 'MANUAL_ONLY', 'Джерело не має машинного інтерфейсу: потрібне ручне підтвердження');
      if (check.source_id === 'dsbt_licenses') return done('unavailable', 'NO_MACHINE_INTERFACE', 'Реєстр віддає HTML, а не дані');
      if (!env[KEY_ENV[check.source_id]]) return done('unavailable', 'NO_API_KEY', 'Джерело потребує ключа або договору; ключ не налаштовано (' + KEY_ENV[check.source_id] + ')');
      return done('unavailable', 'CONNECTOR_NOT_IMPLEMENTED', 'Ключ є, але коннектор до цього джерела ще не написано');
    }

    var pending;
    if (check.source_id === 'vies') {
      pending = callSource('vies', sources.vies, { country: subject.country === 'GR' ? 'EL' : subject.country, vat_number: subject.vat_number }, subject.country + subject.vat_number);
    } else if (check.source_id === 'pl_white_list') {
      pending = ctx.whiteList();
    } else {
      pending = ctx.whiteList().then(function (wl) {
        var krsNo = subject.krs || (wl.outcome === 'ok' && wl.findings.krs) || null;
        if (!krsNo) {
          if (wl.outcome === 'ok' || wl.outcome === 'not_found') {
            return { outcome: 'not_found', http_status: null, content_type: 'application/json', raw: '', source_as_of: wl.source_as_of, findings: {}, reason_code: 'NOT_IN_KRS', reason_text: 'У Biała lista немає номера KRS: суб’єкт не в реєстрі підприємців KRS (для ФОП/JDG потрібен CEIDG, його ще не підключено)' };
          }
          return { outcome: 'unavailable', reason_code: 'KRS_NUMBER_UNKNOWN', reason_text: 'Номер KRS не подано, а Biała lista недоступна, щоб його визначити', findings: {}, raw: null, http_status: null };
        }
        return callSource('pl_krs', sources.krs, { krs: krsNo }, krsNo);
      });
    }
    return pending.then(function (resp) {
      var it = interpret(check, src, subject, resp, ctx);
      var extra = { findings: it.findings, latency_ms: resp.latency_ms === undefined ? null : resp.latency_ms, attempt: resp.attempt || 1 };
      if (resp.raw !== null && resp.raw !== undefined) {
        var ev = saveEvidence(resp.raw);
        var fetched = resp.fetched_at || requestedAt;
        extra.evidence = { payload_sha256: ev.sha, payload_size: ev.size, content_type: resp.content_type || 'application/octet-stream',
          storage_uri: 'local:evidence/' + ev.sha, http_status: resp.http_status === undefined ? null : resp.http_status, fetched_at: fetched,
          source_as_of: resp.source_as_of || null, retention_until: plus(fetched, RETENTION_YEARS * 365).slice(0, 10) };
      }
      if (it.status === 'pass' || it.status === 'attention') {
        var at = resp.fetched_at || now().toISOString();
        extra.responded_at = at; extra.valid_until = plus(at, src.ttl_days);
      } else if (it.status !== 'unavailable' && it.status !== 'not_applicable') {
        extra.responded_at = resp.fetched_at || now().toISOString();
      }
      return done(it.status, it.reason_code, it.reason_text, extra);
    });
  }

  /* ---------- рішення (розділ 5) ---------- */
  function decideAuto(c) {
    var results = c.results;
    var fails = results.filter(function (r) { return r.status === 'fail'; });
    var attention = results.filter(function (r) { return r.status === 'attention'; });
    c.blocking_unavailable = results.filter(function (r) { return r.status === 'unavailable' && SRC[r.source_id].blocking; })
      .map(function (r) { return r.check_id; });
    var at = now().toISOString();
    if (fails.length) {
      c.status = 'rejected'; c.decided_at = at; c.expires_at = null;
      c.decision_reason = 'Рішуча перевірка не пройдена: ' + fails.map(function (r) { return r.check_id + ' (' + r.reason_code + ')'; }).join(', ');
    } else if (c.blocking_unavailable.length || attention.length) {
      c.status = 'manual_review'; c.decided_at = null; c.expires_at = null;
      var why = [];
      if (c.blocking_unavailable.length) why.push('блокуючі перевірки недоступні: ' + c.blocking_unavailable.join(', '));
      if (attention.length) why.push('потребують розгляду: ' + attention.map(function (r) { return r.check_id + ' (' + r.reason_code + ')'; }).join(', '));
      c.decision_reason = 'Автоматичне схвалення неможливе — ' + why.join('; ');
    } else {
      c.status = 'approved'; c.decided_at = at; c.expires_at = plus(at, LEVEL_DAYS[c.target_level]);
      c.decision_reason = 'Усі обов’язкові перевірки пройдено або не блокують рівень';
    }
    event(c.id, 'auto_decision', { status: c.status, blocking_unavailable: c.blocking_unavailable });
  }

  function planChecks(level) {
    return chkList.filter(function (ch) { return ch.required_for === 'L1' || level === 'L2'; });
  }

  function createCase(input) {
    var errs = [];
    if (!input || (input.target_level !== 'L1' && input.target_level !== 'L2')) errs.push('target_level: L1 або L2');
    if (!input || !Array.isArray(input.identifiers) || !input.identifiers.length) errs.push('identifiers: потрібен принаймні один');
    else input.identifiers.forEach(function (i, n) {
      if (!i || ['edrpou', 'vat_eu', 'nip', 'regon', 'krs', 'lei', 'other'].indexOf(i.kind) < 0) errs.push('identifiers[' + n + '].kind');
      if (!i || typeof i.value !== 'string' || i.value.length < 2 || i.value.length > 32) errs.push('identifiers[' + n + '].value: 2–32 символи');
      if (!i || !/^[A-Z]{2}$/.test(i.country || '')) errs.push('identifiers[' + n + '].country: два великі літери');
    });
    if (errs.length) throw problem(422, 'Непридатні дані заявки', errs.join('; '));
    if (input.declared_name && String(input.declared_name).length > 255) throw problem(422, 'Непридатні дані заявки', 'declared_name: до 255 символів');
    var idem = input.idempotency_key;
    if (idem && store.idem[idem]) return { case: store.cases[store.idem[idem]], done: Promise.resolve(), replay: true };

    var s = subjectOf({ country: input.identifiers[0].country, identifiers: input.identifiers, declared_name: input.declared_name, email: input.email });
    var pid = primaryId(s);
    var companyId = uuidFrom(s.country + ':' + pid.kind + ':' + pid.value);
    var activeId = Object.keys(store.cases).filter(function (k) {
      var x = store.cases[k];
      return x.company_id === companyId && x.target_level === input.target_level && ['draft', 'running', 'manual_review', 'awaiting_input'].indexOf(x.status) >= 0;
    })[0];
    if (activeId) {
      var conflict = problem(409, 'Уже існує активна справа для цієї компанії');
      conflict.problem.existing_case_id = activeId;
      throw conflict;
    }

    var created = now().toISOString();
    var c = { id: crypto.randomUUID(), company_id: companyId, target_level: input.target_level, status: 'running', results: [],
      blocking_unavailable: [], decided_at: null, decision_reason: null, expires_at: null, created_at: created, _subject: s };
    store.cases[c.id] = c;
    if (idem) store.idem[idem] = c.id;
    event(c.id, 'case_created', { target_level: c.target_level, country: s.country });

    var wlPromise = null;
    var ctx = { whiteList: function () {
      if (!wlPromise) wlPromise = callSource('pl_white_list', sources.bialaLista, { nip: s.nip || (s.country === 'PL' ? s.vat_number : null) }, s.nip || s.vat_number);
      return wlPromise;
    } };
    var done = Promise.all(planChecks(c.target_level).map(function (ch) {
      return runCheck(ch, s, ctx).then(function (r) { store.resultToCase[r.id] = c.id; event(c.id, 'check_completed', { check_id: r.check_id, status: r.status }); return r; });
    })).then(function (results) {
      c.results = results;
      decideAuto(c);
      persist();
    }, function (err) {
      c.status = 'manual_review'; c.decision_reason = 'Внутрішня помилка виконання перевірок: ' + err.message;
      event(c.id, 'run_failed', { message: err.message });
      persist();
    });
    persist();
    return { case: c, done: done, replay: false };
  }

  function decide(id, body) {
    var c = store.cases[id];
    if (!c) throw problem(404, 'Справу не знайдено');
    var errs = [];
    if (['approve', 'reject', 'request_input'].indexOf(body && body.decision) < 0) errs.push('decision: approve | reject | request_input');
    if (!body || typeof body.reason !== 'string' || body.reason.length < 10 || body.reason.length > 2000) errs.push('reason: 10–2000 символів');
    if (errs.length) throw problem(422, 'Непридатні дані рішення', errs.join('; '));
    if (c.status !== 'manual_review' && c.status !== 'awaiting_input') throw problem(409, 'Рішення можливе лише для справи в ручному розгляді', 'Поточний статус: ' + c.status);
    var at = now().toISOString();
    if (body.decision === 'approve') {
      if (c.results.some(function (r) { return r.status === 'fail'; })) throw problem(409, 'Схвалення неможливе: є рішуча перевірка зі статусом fail');
      var override = body.override_blocking === true;
      if (c.blocking_unavailable.length && !override) throw problem(409, 'Схвалення неможливе через невиконані блокуючі перевірки', c.blocking_unavailable.join(', '));
      var days = LEVEL_DAYS[c.target_level];
      if (c.blocking_unavailable.length && override) {
        days = Math.floor(days / 2);
        event(c.id, 'override_blocking', { blocking_unavailable: c.blocking_unavailable.slice(), reason: body.reason, expires_in_days: days });
        // схема вимагає порожній blocking_unavailable у схваленій справі; що саме подолано - лишається в події журналу
        c.blocking_unavailable = [];
      }
      c.status = 'approved'; c.decided_at = at; c.expires_at = plus(at, days); c.decision_reason = body.reason;
    } else if (body.decision === 'reject') {
      c.status = 'rejected'; c.decided_at = at; c.expires_at = null; c.decision_reason = body.reason;
    } else {
      c.status = 'awaiting_input'; c.decision_reason = body.reason;
    }
    event(c.id, 'operator_decision', { decision: body.decision });
    persist();
    return c;
  }

  function toApi(c) {
    var o = {};
    Object.keys(c).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = c[k]; });
    return o;
  }
  function getCase(id) { return store.cases[id] ? toApi(store.cases[id]) : null; }
  function levelOf(c) {
    if (c.status === 'approved' && c.expires_at && new Date(c.expires_at) > now()) return c.target_level;
    return 'L0';
  }
  function evidenceOf(resultId) {
    var cid = store.resultToCase[resultId];
    if (!cid) return null;
    var r = store.cases[cid].results.filter(function (x) { return x.id === resultId; })[0];
    if (!r || !r.evidence) return null;
    event(cid, 'evidence_access', { result_id: resultId });
    return r.evidence;
  }

  return { createCase: createCase, getCase: getCase, decide: function (id, b) { return toApi(decide(id, b)); }, listSources: listSources,
    events: function (id) { return store.events.filter(function (e) { return e.case_id === id; }); },
    levelOf: function (id) { return store.cases[id] ? levelOf(store.cases[id]) : null; },
    evidenceOf: evidenceOf, readEvidence: readEvidence, planChecks: planChecks };
}

module.exports = { createEngine: createEngine, nameSimilarity: nameSimilarity, uuidFrom: uuidFrom, LEVEL_DAYS: LEVEL_DAYS };
