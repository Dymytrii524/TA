'use strict';
/**
 * Живі джерела верифікації (ТЗ, розділ 4): VIES, Biała lista podatników VAT, KRS.
 * Кожен коннектор повертає одну форму:
 *   { outcome, http_status, content_type, raw, source_as_of, fetched_at, findings, reason_code, reason_text }
 * де outcome - "ok" (джерело відповіло, критерій розбирає engine), "not_found" (204/порожній суб'єкт),
 * "unavailable" (джерело не відповіло або відхилило запит). Коннектор не ухвалює рішень:
 * pass/fail/attention визначає engine за правилами розділу 5.
 *
 * fetch і годинник передаються ззовні, щоб тести не ходили в мережу.
 */

var VIES_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms/';
var WL_BASE = 'https://wl-api.mf.gov.pl/api/search/nip/';
var KRS_BASE = 'https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/';
var TIMEOUT_MS = 8000;

var VIES_DOWN = ['MS_UNAVAILABLE', 'MS_MAX_CONCURRENT_REQ', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'GLOBAL_MAX_CONCURRENT_REQ', 'IP_BLOCKED'];

function unavailable(code, text, extra) {
  var o = { outcome: 'unavailable', http_status: null, content_type: null, raw: null, source_as_of: null,
    findings: {}, reason_code: code, reason_text: text };
  Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
  return o;
}

function getText(deps, url) {
  var ctl = new AbortController();
  var timer = setTimeout(function () { ctl.abort(); }, deps.timeoutMs || TIMEOUT_MS);
  return deps.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': deps.userAgent || 'trans-atlas.net-verification/0.1' }, signal: ctl.signal })
    .then(function (res) {
      return res.text().then(function (text) {
        clearTimeout(timer);
        return { status: res.status, type: (res.headers && res.headers.get && res.headers.get('content-type')) || 'application/json', text: text };
      });
    }, function (err) { clearTimeout(timer); throw err; });
}

function dateOnly(iso) { return String(iso).slice(0, 10); }

/** Дата в Варшаві: Biała lista відхиляє "майбутню" дату, якщо взяти UTC чи локальну дату, що вже випередила Польщу. */
function warsawDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/* ---------- VIES ---------- */
function vies(subject, deps) {
  var cc = subject.country, num = subject.vat_number;
  if (!cc || !num) return Promise.resolve(unavailable('INPUT_MISSING', 'Не задано країну або номер ПДВ'));
  return getText(deps, VIES_BASE + encodeURIComponent(cc) + '/vat/' + encodeURIComponent(num)).then(function (r) {
    var json;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    if (r.status >= 500 || !json) return unavailable('VIES_HTTP_' + r.status, 'VIES відповів HTTP ' + r.status + ' без розбірного JSON', { http_status: r.status });
    if (json.errorWrappers || json.actionSucceed === false) {
      var code = json.errorWrappers && json.errorWrappers[0] && json.errorWrappers[0].error;
      return unavailable('VIES_' + String(code || 'ERROR').toUpperCase().slice(0, 30), 'VIES повернув помилку ' + code, { http_status: r.status, raw: r.text, content_type: r.type });
    }
    if (VIES_DOWN.indexOf(json.userError) >= 0) {
      return unavailable('VIES_' + json.userError, 'Реєстр держави-члена недоступний (' + json.userError + ')', { http_status: r.status, raw: r.text, content_type: r.type });
    }
    return {
      outcome: 'ok', http_status: r.status, content_type: r.type, raw: r.text,
      source_as_of: dateOnly(json.requestDate || deps.now().toISOString()),
      findings: { valid: json.isValid === true, user_error: json.userError || null, name: json.name && json.name !== '---' ? json.name : null, address: json.address && json.address !== '---' ? json.address : null },
      reason_code: null, reason_text: null
    };
  }, function (err) { return unavailable('VIES_NETWORK', 'VIES недоступний: ' + (err && err.message)); });
}

/* ---------- Biała lista ---------- */
function bialaLista(subject, deps) {
  if (!subject.nip) return Promise.resolve(unavailable('INPUT_MISSING', 'Не задано NIP'));
  var date = warsawDate(deps.now());
  return getText(deps, WL_BASE + encodeURIComponent(subject.nip) + '?date=' + date).then(function (r) {
    var json;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    if (r.status === 429) return unavailable('WL_RATE_LIMITED', 'Перевищено добовий ліміт запитів Biała lista', { http_status: 429 });
    if (r.status >= 500) return unavailable('WL_HTTP_' + r.status, 'Biała lista відповіла HTTP ' + r.status, { http_status: r.status });
    if (r.status >= 400 || !json) {
      return unavailable('WL_REJECTED_' + r.status, 'Biała lista відхилила запит: ' + ((json && json.message) || 'HTTP ' + r.status), { http_status: r.status, raw: r.text, content_type: r.type });
    }
    var sub = json.result && json.result.subject;
    if (!sub) {
      return { outcome: 'not_found', http_status: r.status, content_type: r.type, raw: r.text, source_as_of: date, findings: {}, reason_code: 'NOT_IN_WHITE_LIST', reason_text: 'NIP відсутній у Wykaz podatników VAT' };
    }
    var accounts = (sub.accountNumbers || []).slice().sort();
    return {
      outcome: 'ok', http_status: r.status, content_type: r.type, raw: r.text, source_as_of: date,
      findings: {
        name: sub.name || null, status_vat: sub.statusVat || null, nip: sub.nip || null, regon: sub.regon || null, krs: sub.krs || null,
        registration_legal_date: sub.registrationLegalDate || null, removal_date: sub.removalDate || null,
        account_count: accounts.length, accounts_sha256: deps.sha256(accounts.join(',')), has_virtual_accounts: sub.hasVirtualAccounts === true
      },
      reason_code: null, reason_text: null
    };
  }, function (err) { return unavailable('WL_NETWORK', 'Biała lista недоступна: ' + (err && err.message)); });
}

/* ---------- KRS ---------- */
function krs(subject, deps) {
  if (!subject.krs) return Promise.resolve(unavailable('INPUT_MISSING', 'Не задано номер KRS'));
  var num = String(subject.krs).replace(/\D/g, '');
  while (num.length < 10) num = '0' + num;
  return getText(deps, KRS_BASE + num + '?rejestr=P&format=json').then(function (r) {
    if (r.status === 204) {
      // 204 = немає в цьому реєстрі; це відповідь джерела, а не його недоступність (каталог, identity.registry_match_pl)
      return { outcome: 'not_found', http_status: 204, content_type: r.type, raw: '', source_as_of: dateOnly(deps.now().toISOString()), findings: {}, reason_code: 'NOT_IN_KRS', reason_text: 'Суб’єкта немає в реєстрі підприємців KRS (HTTP 204)' };
    }
    var json;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    if (r.status === 429) return unavailable('KRS_RATE_LIMITED', 'Перевищено ліміт запитів KRS', { http_status: 429 });
    if (r.status >= 400 || !json || !json.odpis) return unavailable('KRS_HTTP_' + r.status, 'KRS відповів HTTP ' + r.status + ' без витягу', { http_status: r.status });
    var h = json.odpis.naglowekA || {};
    var d1 = (json.odpis.dane && json.odpis.dane.dzial1 && json.odpis.dane.dzial1.danePodmiotu) || {};
    var d6 = (json.odpis.dane && json.odpis.dane.dzial6) || {};
    var flagged = Object.keys(d6).filter(function (k) { return /likwid|upadl|upadł/i.test(k); });
    var stan = h.stanZDnia && /^(\d\d)\.(\d\d)\.(\d{4})$/.exec(h.stanZDnia);
    return {
      outcome: 'ok', http_status: r.status, content_type: r.type, raw: r.text,
      source_as_of: stan ? stan[3] + '-' + stan[2] + '-' + stan[1] : null,
      findings: {
        krs: h.numerKRS || num, name: d1.nazwa || null, legal_form: d1.formaPrawna || null,
        nip: d1.identyfikatory && d1.identyfikatory.nip || null, regon: d1.identyfikatory && d1.identyfikatory.regon || null,
        last_entry_date: h.dataOstatniegoWpisu || null, liquidation_or_bankruptcy_sections: flagged
      },
      reason_code: null, reason_text: null
    };
  }, function (err) { return unavailable('KRS_NETWORK', 'KRS недоступний: ' + (err && err.message)); });
}

module.exports = { vies: vies, bialaLista: bialaLista, krs: krs, warsawDate: warsawDate };
