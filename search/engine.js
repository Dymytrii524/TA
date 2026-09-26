'use strict';
/**
 * Рушій модуля SEARCH (ТЗ, додаток A): пошук маршрутів по заявках-пропозиціях
 * транспорту + пост-обробка POST_DRONE + ранжування A.7.
 *
 * Працює однаково в браузері (window.TransAtlasSearch) і в Node (require).
 * Без залежностей. Детермінований: ті самі вхідні дані дають ту саму видачу
 * (у відповіді немає ні Math.random, ні поточного часу).
 *
 * Що реалізовано на даних сайту (LISTINGS + CITIES):
 *  - граф сполучень із заявок kind=transport, види A/T/M/F (D - лише пост-обробка);
 *  - порядок гілок A.6.4 як автомат: [A] [T] [M|F] [T] [A];
 *  - підстановка найближчих пунктів за координатами в радіусі (A.6.10),
 *    вартість такого плеча - медіана EUR/км за видом (прапорець estimated_price);
 *  - нормалізація вартості в базову валюту за таблицею курсів (A.5);
 *  - ранжування S' (A.7): min-max по варіантах гілок, ваги, штрафи, стабільне
 *    сортування, пас закріплення order_pinned_below;
 *  - POST_DRONE: ворота 1-6, коди причин, drone_cta, діагностика, бюджет,
 *    "чесна" погода (невідома => ok:null + weather_risk + partial).
 *
 * Чого тут немає (потрібна БД і сервіс): link_stats з історії, рейтинги
 * компаній (за їх відсутності Rt нейтральне 0.5 і не впливає на порядок),
 * документи CMR/T1/TIR (customs_missing не виставляється), асинхронний
 * режим 202 для 2+ перевантажень.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TransAtlasSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  var CODE_OF = { auto: 'A', rail: 'T', sea: 'M', air: 'F', drone: 'D' };
  var MODE_UK = { A: 'авто', T: 'жд', M: 'море', F: 'авіа', D: 'дрон' };
  var HOUR = 3600 * 1000;

  var DEFAULTS = {
    weights: {
      cost: { wc: 0.55, wt: 0.10, wk: 0.15, wr: 0.10, wn: 0.10 },
      time: { wc: 0.10, wt: 0.55, wk: 0.10, wr: 0.10, wn: 0.15 },
      balanced: { wc: 0.30, wt: 0.30, wk: 0.15, wr: 0.15, wn: 0.10 }
    },
    penalties: { weather_risk: 0.08, no_permit: 0.10, customs_missing: 0.06, estimated_price: 0.03 },
    speeds_kmh: { A: 50, T: 40, M: 30, F: 650, D: 60 },
    handling: { eur: 50, hours: 8 },
    drone_range_margin: 0.8,
    drone_wind_limit_ms: 12,
    pad_max_dist_to_dest_km: 50,
    max_legs: 4,
    max_wait_h: 96,
    detour_factor: 2.2,
    max_visits: 400000,
    max_candidates: 4000,
    route_limit: 10,
    route_time_limit_ms: 3000,
    drone_budget_cap_ms: 800,
    drone_budget_share: 0.12,
    substitute_hubs: 3,
    no_fly_zones: {}
  };

  /* Демонстраційні курси: сайт не має підключеного джерела курсів (A.5 вимагає
   * джерело і час фіксації). Позначено demo:true, інтерфейс це показує. */
  var DEMO_FX = {
    base: 'EUR', as_of: '2026-09-01', demo: true, source: 'демонстраційна таблиця, не котирування',
    rates: {
      EUR: 1, USD: 0.92, UAH: 0.022, PLN: 0.23, CZK: 0.040, RON: 0.20, GBP: 1.17, CHF: 1.05, HUF: 0.0025,
      BGN: 0.51, SEK: 0.088, DKK: 0.134, NOK: 0.086, TRY: 0.026, RSD: 0.0085, MDL: 0.051, CAD: 0.67,
      MXN: 0.047, CNY: 0.13, JPY: 0.0062, AED: 0.25, SGD: 0.69, INR: 0.011, KRW: 0.00067, GEL: 0.34,
      AZN: 0.54, KZT: 0.0018, UZS: 0.000072, AMD: 0.0024, USDC: 0.92, USDT: 0.92, EURC: 1
    }
  };

  function merge(base, over) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(over || {}).forEach(function (k) {
      var v = over[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object')
        ? merge(base[k], v) : v;
    });
    return out;
  }

  function rad(d) { return d * Math.PI / 180; }
  function haversineKm(a, b) {
    var dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  function median(xs) {
    if (!xs.length) return null;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function round(x, n) { var p = Math.pow(10, n); return Math.round(x * p) / p; }
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
  function dayMs(iso) { return Date.parse(iso + 'T08:00:00Z'); }
  function isoOf(ms) { return new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z'); }

  /* ---------- синтетичний світ для сценаріїв T16-T27 і демо на сайті ----------
   * Міста лежать на екваторі: 1 градус довготи = 111.19 км, тож відстані (39 км, 42 км, 6 км)
   * задаються довготою, а не вгадуються. */
  var KM = 1 / 111.19;
  function city(id, km, uk, en) { return { id: id, uk: uk || id, en: en || id, lat: 0, lon: km * KM, country: 'XX' }; }

  function syntheticWorld(o) {
    o = o || {};
    var d2 = o.range === undefined ? 39 : o.range;   // відстань останнього плеча X -> P2, км
    var cities = [city('o', 0, 'Початок', 'Origin'), city('port', 300, 'Порт', 'Port'), city('x', 600, 'Вузол X', 'Hub X'), city('p2', 600 + d2, 'Кінець P2', 'Destination P2'), city('pad', 600 + d2 - 6, 'Майданчик P2′', 'Pad P2′'), city('far', 2000, 'Далеко', 'Far')];
    var id = 0;
    function lot(mode, from, to, extra) {
      var l = { id: ++id, kind: 'transport', mode: mode, from: from, to: to, date: '2026-09-03', weight: 30, volume: 90, price: 500, currency: 'EUR', company: 'Test ' + mode };
      Object.keys(extra || {}).forEach(function (k) { l[k] = extra[k]; });
      return l;
    }
    var L = [];
    if (o.lastLeg === 'rail') {
      L.push(lot('sea', 'o', 'port', { date: '2026-09-01' }));
      L.push(lot('rail', 'port', 'p2', { date: '2026-09-02' }));
    } else {
      L.push(lot('rail', 'o', 'x', { date: '2026-09-01' }));
      L.push(lot('auto', 'x', 'p2', { price: o.autoPrice || 500 }));
    }
    if (o.directDrone) L.push(lot('drone', 'x', 'p2', Object.assign({ weight: 0.02, weightUnit: 'kg', price: o.dronePrice || 60, rangeKm: 50, maxPayloadKg: 20, flightPermit: true }, o.directDrone === true ? {} : o.directDrone)));
    if (o.padDrone) L.push(lot('drone', 'x', 'pad', { weight: 0.02, weightUnit: 'kg', price: 40, rangeKm: 50, maxPayloadKg: 20, flightPermit: true }));
    if (o.padTail) L.push(lot('auto', 'pad', 'p2', { price: 30, date: '2026-09-04' }));
    if (o.extraBranch) L.push(lot('auto', 'o', 'p2', { price: 900, date: '2026-09-02' }));
    return { cities: cities, listings: L };
  }


  /* Сценарії POST_DRONE для демо на сайті: на реальних даних жоден дрон-лот не проходить ворота
   * дальності (заявки згенеровані без географії), тому дрон-модуль показується на синтетичному світі. */
  var DEMO_SCENARIOS = {
    T17: { world: { directDrone: true }, wind: 5, config: { no_fly_zones: { p2: { permit: false, zone: 'border_strip', permit_id: null } } } },
    T18: { world: { range: 39, directDrone: true }, wind: 5 },
    T20: { world: { padDrone: true, padTail: true }, wind: 5 },
    T21: { world: { directDrone: true, dronePrice: 10 }, wind: 15 },
    T23: { world: { padDrone: true }, wind: 5 }
  };

  /* ---------- підготовка даних ---------- */
  function prepare(data, req, cfg) {
    var cities = {}, idNum = {};
    (data.cities || []).forEach(function (c, i) { cities[c.id] = c; idNum[c.id] = i + 1; });
    var fx = data.fx || DEMO_FX;
    var w = Number(req.weight_t) || 0, vol = Number(req.volume_m3) || 0;
    var modes = {};
    (req.modes || ['A', 'T', 'M', 'F', 'D']).forEach(function (m) { modes[m] = true; });

    var idx = { cities: cities, idNum: idNum, fx: fx, modes: modes, out: {}, inc: {}, pair: {},
      drone: [], skippedFx: 0, rate: {} };
    var perMode = {};

    (data.listings || []).forEach(function (l) {
      if (l.kind !== 'transport') return;
      var m = CODE_OF[l.mode];
      if (!m || !cities[l.from] || !cities[l.to] || l.from === l.to) return;
      var r = fx.rates[l.currency];
      if (r === undefined) { idx.skippedFx++; return; }
      var dist = haversineKm(cities[l.from], cities[l.to]);
      var e = {
        mode: m, from: l.from, to: l.to, lot: l.id, company: l.company, date: l.date,
        dist: dist, cost: Number(l.price) * r, currency: l.currency, price: l.price,
        hours: dist / cfg.speeds_kmh[m], estimated: false,
        rangeKm: l.rangeKm, maxPayloadKg: l.maxPayloadKg, flightPermit: l.flightPermit
      };
      if (m === 'D') { idx.drone.push(e); return; }
      var cap = l.weightUnit === 'kg' ? l.weight / 1000 : l.weight;
      if (w && cap !== undefined && cap < w) return;
      if (vol && l.volume !== undefined && l.volume < vol) return;
      (perMode[m] = perMode[m] || []).push(e);
    });

    Object.keys(perMode).forEach(function (m) {
      var rates = perMode[m].filter(function (e) { return e.dist >= 1; })
        .map(function (e) { return e.cost / e.dist; });
      idx.rate[m] = median(rates);
      // 3 найдешевші лоти на пару+вид та найранніший: обмежує розгалуження без втрати часових альтернатив
      var groups = {};
      perMode[m].forEach(function (e) {
        var k = e.from + '|' + e.to;
        (groups[k] = groups[k] || []).push(e);
      });
      Object.keys(groups).sort().forEach(function (k) {
        var g = groups[k].sort(function (a, b) { return a.cost - b.cost || a.lot - b.lot; });
        var keep = g.slice(0, 3);
        var earliest = groups[k].slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.lot - b.lot; })[0];
        if (keep.indexOf(earliest) < 0) keep.push(earliest);
        keep.forEach(function (e) {
          (idx.out[e.from] = idx.out[e.from] || []).push(e);
          (idx.inc[e.to] = idx.inc[e.to] || []).push(e);
          if (m === 'A') (idx.pair[k] = idx.pair[k] || []).push(e);
        });
      });
    });
    return idx;
  }

  /* ---------- гілки: обхід графа ---------- */
  function slotOf(cur, m) {
    var slots = m === 'A' ? [0, 4] : m === 'T' ? [1, 3] : [2];
    for (var i = 0; i < slots.length; i++) if (slots[i] > cur) return slots[i];
    return -1;
  }

  function virtualEdges(idx, req, cfg, o, d) {
    var rate = idx.rate.A;
    if (!idx.modes.A || !rate) return;
    var C = idx.cities;
    function nearest(pt, filter, radius) {
      return Object.keys(C).filter(function (id) { return id !== pt && filter(id); })
        .map(function (id) { return { id: id, d: haversineKm(C[pt], C[id]) }; })
        .filter(function (x) { return x.d <= radius; })
        .sort(function (a, b) { return a.d - b.d || (a.id < b.id ? -1 : 1); })
        .slice(0, cfg.substitute_hubs);
    }
    function vEdge(from, to, dist) {
      return { mode: 'A', from: from, to: to, lot: null, company: null, date: null, dist: dist,
        cost: rate * dist, hours: dist / cfg.speeds_kmh.A, estimated: true };
    }
    var ro = req.radius_km && req.radius_km.origin, rd = req.radius_km && req.radius_km.destination;
    if (ro > 0) {
      nearest(o, function (id) {
        return (idx.out[id] || []).some(function (e) { return e.mode !== 'A'; });
      }, ro).forEach(function (n) {
        var has = (idx.out[o] || []).some(function (e) { return e.to === n.id && e.mode === 'A'; });
        if (!has) (idx.out[o] = idx.out[o] || []).push(vEdge(o, n.id, n.d));
      });
    }
    if (rd > 0) {
      nearest(d, function (id) {
        return (idx.inc[id] || []).some(function (e) { return e.mode !== 'A'; });
      }, rd).forEach(function (n) {
        var has = (idx.out[n.id] || []).some(function (e) { return e.to === d && e.mode === 'A'; });
        if (!has) (idx.out[n.id] = idx.out[n.id] || []).push(vEdge(n.id, d, n.d));
      });
    }
  }

  function timeLeg(e, readyMs, cfg, firstLeg) {
    // Без depart_from перше плече-підстановка «плаваюче»: час вирівнюється по наступному лоту в fixFlex
    if (e.estimated) return { dep: readyMs, arr: readyMs + e.hours * HOUR };
    var dep = dayMs(e.date);
    if (dep < readyMs) return null;
    if (!firstLeg && isFinite(readyMs) && dep - readyMs > cfg.max_wait_h * HOUR) return null;
    return { dep: dep, arr: dep + e.hours * HOUR };
  }

  function fixFlex(legs, cfg) {
    if (legs.length > 1 && legs[0].dep === -Infinity) {
      var a = legs[0], arr = legs[1].dep - cfg.handling.hours * HOUR;
      legs[0] = { e: a.e, dep: arr - a.e.hours * HOUR, arr: arr };
    }
    return legs;
  }

  function findBranches(idx, req, cfg) {
    var o = req.origin, d = req.destination, C = idx.cities;
    var maxLegs = Math.min(cfg.max_legs, (req.max_transships === undefined ? 3 : req.max_transships) + 1);
    var direct = haversineKm(C[o], C[d]);
    var maxPath = direct * cfg.detour_factor + 200;
    var startMs = req.depart_from ? dayMs(req.depart_from) - 8 * HOUR : -Infinity;
    var endMs = req.arrive_by ? Date.parse(req.arrive_by + 'T23:59:59Z') : Infinity;
    var out = [], seen = {}, visits = 0, truncated = false;

    function dfs(city, legs, visited, readyMs, slot, prevMode, pathKm) {
      if (truncated) return;
      var edges = idx.out[city] || [];
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (++visits > cfg.max_visits) { truncated = true; return; }
        if (!idx.modes[e.mode] || e.mode === prevMode || visited[e.to]) continue;
        var s = slotOf(slot, e.mode);
        if (s < 0) continue;
        if (pathKm + e.dist > maxPath) continue;
        var tm = timeLeg(e, readyMs, cfg, legs.length === 0);
        if (!tm || tm.arr > endMs) continue;
        var leg = { e: e, dep: tm.dep, arr: tm.arr };
        legs.push(leg); visited[e.to] = true;
        if (e.to === d) {
          if (!legs.some(function (l) { return l.e.lot !== null; })) { legs.pop(); visited[e.to] = false; continue; }
          var key = legs.map(function (l) { return l.e.lot === null ? l.e.mode + l.e.from + l.e.to : l.e.lot; }).join('>');
          if (!seen[key] && out.length < cfg.max_candidates) { seen[key] = true; out.push(fixFlex(legs.slice(), cfg)); }
        } else if (legs.length < maxLegs) {
          dfs(e.to, legs, visited, tm.arr + cfg.handling.hours * HOUR, s, e.mode, pathKm + e.dist);
        }
        legs.pop(); visited[e.to] = false;
      }
    }
    var visited = {}; visited[o] = true;
    dfs(o, [], visited, startMs, -1, null, 0);
    return { routes: out, truncated: truncated };
  }

  /* ---------- побудова об'єктів маршруту ---------- */
  function makeCtx(idx, req, cfg, opts) {
    var C = idx.cities;
    return {
      idx: idx, req: req, cfg: cfg,
      point: function (id, kind) {
        var c = C[id];
        var name = opts.name ? opts.name(c) : (c.en || c.uk || id);
        return { id: idx.idNum[id], code: id, kind: kind || 'city', name: name };
      }
    };
  }

  function legObject(ctx, l) {
    var e = l.e;
    var o = {
      mode: e.mode, from: ctx.point(e.from), to: ctx.point(e.to),
      lot_id: e.lot === null ? undefined : e.lot,
      depart: isoOf(l.dep), arrive: isoOf(l.arr),
      distance_km: round(e.dist, 1), cost_eur: round(e.cost, 2), transit_h: round(e.hours, 1)
    };
    if (e.company) o.company = { name: e.company };
    if (e.estimated) o.estimated = true;
    if (e.lot === null) delete o.lot_id;
    return o;
  }

  function routeStats(legs, cfg) {
    var handling = Math.max(0, legs.length - 1);
    var cost = 0, rail = 0, est = false;
    legs.forEach(function (l) {
      cost += l.e.cost;
      if (l.e.mode === 'T') rail++;
      if (l.e.estimated) est = true;
    });
    cost += handling * cfg.handling.eur;
    var hours = (legs[legs.length - 1].arr - legs[0].dep) / HOUR;
    return { cost: cost, hours: hours, transships: handling, coeff: handling - rail, estimated: est };
  }

  function schemeOf(legs) {
    return 'A — ' + legs.map(function (l) { return MODE_UK[l.e.mode]; }).join(' — ') + ' — B';
  }

  /* ---------- ранжування A.7 ---------- */
  function minmax(vals) {
    return { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) };
  }
  // База з одного значення (min = max): гілки дають 0, а дрон-варіант, який лежить поза базою,
  // міряється відхиленням від неї у частках, інакше вигода дрона зникала б у нормалізації.
  function norm(x, mm) { return (x - mm.min) / ((mm.max - mm.min) || Math.abs(mm.min) || 1); }

  function scoreOf(r, base, cfg, criterion, nMax, ratings) {
    var w = cfg.weights[criterion] || cfg.weights.balanced;
    var rt = 0.5;
    if (ratings) {
      var rs = r._companies.map(function (c) { return ratings[c]; }).filter(function (v) { return v !== undefined; });
      if (rs.length) rt = rs.reduce(function (a, b) { return a + b; }, 0) / rs.length / 5;
    }
    var s = w.wc * norm(r._cost, base.cost) + w.wt * norm(r._hours, base.time) +
      w.wk * norm(r.preference_coeff, base.coeff) + w.wr * (1 - rt) + w.wn * (r.transships / nMax);
    r.warnings.forEach(function (f) { s += cfg.penalties[f] || 0; });
    return round(s, 4);
  }

  function cmpRoutes(a, b) {
    return a.score - b.score || (a.route_id < b.route_id ? -1 : a.route_id > b.route_id ? 1 : 0);
  }

  function pinPass(list) {
    var pinned = list.filter(function (r) { return r.order_pinned_below; });
    pinned.sort(function (a, b) { return list.indexOf(a) - list.indexOf(b); });
    pinned.forEach(function (p) {
      var anchor = -1;
      list.forEach(function (r, i) { if (r.route_id === p.order_pinned_below) anchor = i; });
      var pos = list.indexOf(p);
      if (anchor >= 0 && pos < anchor) {
        list.splice(pos, 1);
        list.splice(list.findIndex(function (r) { return r.route_id === p.order_pinned_below; }) + 1, 0, p);
      }
    });
    return list;
  }

  /* ---------- POST_DRONE ---------- */
  function gateFail(diag, parentId, gate, reason, detail) {
    var d = { parent_route: parentId, gate: gate, reason: reason };
    if (detail) d.detail = detail;
    diag.push(d);
  }

  function postDrone(ctx, parent, weatherFn) {
    var idx = ctx.idx, req = ctx.req, cfg = ctx.cfg, C = idx.cities;
    var res = { diag: [], variant: null, cta: null, parentWarn: null, weatherUnknown: false };
    var legs = parent._legs, last = legs[legs.length - 1];
    var pid = parent.route_id;
    var X = last.e.from, P2 = last.e.to;

    if (last.e.mode !== 'A') { gateFail(res.diag, pid, 1, 'not_last_auto_leg', { last_mode: last.e.mode }); return Promise.resolve(res); }

    var zone = cfg.no_fly_zones[P2];
    if (zone && zone.permit === false) {
      gateFail(res.diag, pid, 2, 'no_permit', { zone: zone.zone || 'restricted', permit_id: zone.permit_id || null });
      res.parentWarn = 'no_permit';
      return Promise.resolve(res);
    }

    var wKg = (Number(req.weight_t) || 0) * 1000;
    var cargo = req.cargo || {};

    function lotTime(e, ready) {
      var dep = dayMs(e.date);
      if (dep < ready || (isFinite(ready) && dep - ready > cfg.max_wait_h * HOUR)) return null;
      return { dep: dep, arr: dep + e.hours * HOUR };
    }
    var readyForDrone = legs.length > 1
      ? legs[legs.length - 2].arr + cfg.handling.hours * HOUR
      : (req.depart_from ? dayMs(req.depart_from) - 8 * HOUR : -Infinity);

    // gate 3+4 for one drone lot; returns null if passes, otherwise {gate, reason, detail}
    function gates34(e) {
      var limit = e.rangeKm * cfg.drone_range_margin;
      if (!(e.rangeKm > 0) || e.dist > limit) {
        return { gate: 3, reason: 'out_of_range', detail: { distance_km: round(e.dist, 1), limit_km: round(limit || 0, 1), range_km: e.rangeKm, margin: cfg.drone_range_margin } };
      }
      if (cargo.adr_class) return { gate: 4, reason: 'cargo_not_allowed', detail: { rule: 'adr', adr_class: cargo.adr_class } };
      if (cargo.live_animals) return { gate: 4, reason: 'cargo_not_allowed', detail: { rule: 'live_animals' } };
      if (!(e.maxPayloadKg >= wKg)) {
        return { gate: 4, reason: 'cargo_not_allowed', detail: { rule: 'payload', weight_kg: wKg, max_payload_kg: e.maxPayloadKg === undefined ? null : e.maxPayloadKg } };
      }
      return null;
    }

    var direct = idx.drone.filter(function (e) { return e.from === X && e.to === P2 && lotTime(e, readyForDrone); });
    var chosen = null, tail = null, extra = false;

    if (direct.length) {
      var passing = [], fails = [];
      direct.forEach(function (e) { var f = gates34(e); if (f) fails.push(f); else passing.push(e); });
      if (!passing.length) {
        var f0 = fails.filter(function (f) { return f.gate === 4; })[0] || fails[0];
        gateFail(res.diag, pid, f0.gate, f0.reason, f0.detail);
        return Promise.resolve(res);
      }
      passing.sort(function (a, b) { return a.cost - b.cost || a.lot - b.lot; });
      chosen = passing[0];
    } else {
      gateFail(res.diag, pid, 5, 'no_drone_lot');
      if (cargo.adr_class || cargo.live_animals) {
        res.diag.pop();
        gateFail(res.diag, pid, 4, 'cargo_not_allowed', cargo.adr_class ? { rule: 'adr', adr_class: cargo.adr_class } : { rule: 'live_animals' });
        return Promise.resolve(res);
      }
      if (req.drone && req.drone.allow_extra_leg === false) {
        gateFail(res.diag, pid, 5, 'extra_leg_disabled');
        return Promise.resolve(res);
      }
      var pads = idx.drone.filter(function (e) {
        if (e.from !== X || e.to === P2 || !lotTime(e, readyForDrone)) return false;
        var z = cfg.no_fly_zones[e.to];
        if (z && z.permit === false) return false;
        if (gates34(e)) return false;
        return haversineKm(C[e.to], C[P2]) <= cfg.pad_max_dist_to_dest_km;
      }).map(function (e) { return { e: e, dd: haversineKm(C[e.to], C[P2]) }; })
        .sort(function (a, b) { return a.dd - b.dd || a.e.lot - b.e.lot; });
      if (!pads.length) { gateFail(res.diag, pid, 5, 'no_landing_pad'); return Promise.resolve(res); }
      var pad = pads[0];
      var dt = lotTime(pad.e, readyForDrone);
      var tails = (idx.pair[pad.e.to + '|' + P2] || []).filter(function (e) { return lotTime(e, dt.arr + cfg.handling.hours * HOUR); });
      tails.sort(function (a, b) { return a.cost - b.cost || a.lot - b.lot; });
      if (!tails.length) {
        res.cta = {
          parent_route: pid,
          pad: { id: idx.idNum[pad.e.to], name: ctx.point(pad.e.to, 'drone_pad').name, distance_to_dest_km: round(pad.dd, 1) },
          missing_leg: { mode: 'A', from: idx.idNum[pad.e.to], to: idx.idNum[P2] },
          action: 'create_lot'
        };
        return Promise.resolve(res);
      }
      if (legs.length + 1 > cfg.max_legs) {
        gateFail(res.diag, pid, 5, 'max_legs_exceeded', { legs_required: legs.length + 1, max_legs: cfg.max_legs });
        return Promise.resolve(res);
      }
      chosen = pad.e; tail = tails[0]; extra = true;
    }

    var dTime = lotTime(chosen, readyForDrone);
    var newLegs = legs.slice(0, -1);
    newLegs.push({ e: chosen, dep: dTime.dep, arr: dTime.arr });
    if (tail) {
      var tt = lotTime(tail, dTime.arr + cfg.handling.hours * HOUR);
      newLegs.push({ e: tail, dep: tt.dep, arr: tt.arr });
    }
    if (req.arrive_by && newLegs[newLegs.length - 1].arr > Date.parse(req.arrive_by + 'T23:59:59Z')) {
      gateFail(res.diag, pid, 5, 'no_drone_lot', { reason: 'arrive_by' });
      return Promise.resolve(res);
    }

    var st = routeStats(newLegs, cfg);
    var droneLeg = legObject(ctx, newLegs[newLegs.length - (tail ? 2 : 1)]);
    droneLeg.to = ctx.point(chosen.to, extra ? 'drone_pad' : 'city');
    droneLeg.range_used_km = round(chosen.dist, 1);
    droneLeg.payload_kg = wKg || undefined;
    if (!wKg) delete droneLeg.payload_kg;
    droneLeg.permit_id = null;

    var variant = {
      route_id: pid + '_d', variant_of: pid, origin: 'post_drone',
      scheme: schemeOf(newLegs), transships: st.transships, preference_coeff: st.coeff,
      total_cost_eur: round(st.cost, 2), cost_known: true, estimated_price: st.estimated,
      total_time_h: round(st.hours, 1), warnings: [],
      legs: newLegs.map(function (l) { return legObject(ctx, l); }),
      _cost: st.cost, _hours: st.hours, _legs: newLegs, _companies: newLegs.map(function (l) { return l.e.company; }).filter(Boolean)
    };
    variant.legs[newLegs.length - (tail ? 2 : 1)] = droneLeg;
    if (chosen.flightPermit === false) variant.warnings.push('no_permit');
    if (st.estimated) variant.warnings.push('estimated_price');

    function finish(w) {
      var limit = cfg.drone_wind_limit_ms, weather;
      if (w && typeof w.wind_ms === 'number') {
        weather = { wind_ms: w.wind_ms, ok: w.wind_ms <= limit, limit_ms: limit };
      } else {
        weather = { wind_ms: null, ok: null, limit_ms: limit, source_error: (w && w.error) || 'weather_service_unavailable' };
        res.weatherUnknown = true;
      }
      droneLeg.weather = weather;
      if (weather.ok !== true) {
        variant.warnings.push('weather_risk');
        variant.order_pinned_below = pid;
      }
      res.variant = variant;
      return res;
    }
    var p;
    try { p = weatherFn ? weatherFn(C[X], C[chosen.to], isoOf(dTime.dep)) : null; } catch (err) { p = null; }
    return Promise.resolve(p).then(finish, function (err) { return finish({ error: String(err && err.message || err) }); });
  }

  /* ---------- fallback A.6.14/A.6.15 ---------- */
  function fallbacks(idx, req, cfg) {
    var C = idx.cities, co = C[req.origin].country, cd = C[req.destination].country, seen = {}, companies = [], links = [];
    var all = [];
    Object.keys(idx.out).forEach(function (k) { idx.out[k].forEach(function (e) { if (e.lot !== null) all.push(e); }); });
    all.forEach(function (e) {
      if (C[e.from].country === co && C[e.to].country === cd && e.company && !seen[e.company]) { seen[e.company] = true; companies.push({ name: e.company, mode: e.mode }); }
    });
    var ro = (req.radius_km && req.radius_km.origin) || 300;
    all.filter(function (e) { return haversineKm(C[req.origin], C[e.from]) <= ro; })
      .sort(function (a, b) { return haversineKm(C[a.to], C[req.destination]) - haversineKm(C[b.to], C[req.destination]) || a.lot - b.lot; })
      .slice(0, 5).forEach(function (e) {
        links.push({ mode: e.mode, from: e.from, to: e.to, lot_id: e.lot, remaining_km: round(haversineKm(C[e.to], C[req.destination]), 0) });
      });
    companies.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return { companies: companies.slice(0, 10), links: links };
  }

  /* ---------- головна функція ---------- */
  function search(req, data, opts) {
    opts = opts || {};
    var cfg = merge(DEFAULTS, opts.config || {});
    var now = opts.now || function () { return Date.now(); };
    var t0 = now();
    var C = {}; (data.cities || []).forEach(function (c) { C[c.id] = c; });
    if (!C[req.origin] || !C[req.destination]) {
      return Promise.reject(new Error('unknown_origin_or_destination'));
    }
    var idx = prepare(data, req, cfg);
    virtualEdges(idx, req, cfg, req.origin, req.destination);
    var found = findBranches(idx, req, cfg);
    var criterion = req.criterion || 'balanced';
    var nMax = Math.max(1, req.max_transships === undefined ? 3 : req.max_transships);

    var cands = found.routes.map(function (legs) {
      var st = routeStats(legs, cfg);
      return { legs: legs, st: st };
    });
    cands.sort(function (a, b) {
      return a.st.cost - b.st.cost || a.st.hours - b.st.hours ||
        (a.legs.map(function (l) { return l.e.lot; }).join() < b.legs.map(function (l) { return l.e.lot; }).join() ? -1 : 1);
    });
    var base = {
      cost: minmax(cands.map(function (c) { return c.st.cost; })),
      time: minmax(cands.map(function (c) { return c.st.hours; })),
      coeff: minmax(cands.map(function (c) { return c.st.coeff; }))
    };
    if (!cands.length) base = { cost: { min: 0, max: 0 }, time: { min: 0, max: 0 }, coeff: { min: 0, max: 0 } };

    var ctx = makeCtx(idx, req, cfg, opts);
    var branch = cands.map(function (c, i) {
      var r = {
        route_id: 'rt_' + (i + 1), origin: 'branch', scheme: schemeOf(c.legs),
        transships: c.st.transships, preference_coeff: c.st.coeff,
        total_cost_eur: round(c.st.cost, 2), cost_known: true, estimated_price: c.st.estimated,
        total_time_h: round(c.st.hours, 1), warnings: c.st.estimated ? ['estimated_price'] : [],
        legs: c.legs.map(function (l) { return legObject(ctx, l); }),
        _cost: c.st.cost, _hours: c.st.hours, _legs: c.legs,
        _companies: c.legs.map(function (l) { return l.e.company; }).filter(Boolean)
      };
      r.score = scoreOf(r, base, cfg, criterion, nMax, opts.ratings);
      return r;
    });
    branch.sort(cmpRoutes);
    var top = branch.slice(0, req.limit || cfg.route_limit);

    var response = {
      search_id: 'srch_' + hash(JSON.stringify(req) + '|' + (data.listings || []).length + '|' + (data.cities || []).length),
      base_currency_code: idx.fx.base,
      fx: { as_of: idx.fx.as_of, demo: !!idx.fx.demo, source: idx.fx.source },
      partial: false,
      branch_reached: top.length ? top[0]._legs.map(function (l) { return MODE_UK[l.e.mode]; }).join(' → ') : null,
      routes: null
    };
    if (found.truncated) { response.partial = true; response.search_truncated = true; }
    if (idx.skippedFx) { response.partial = true; response.skipped_lots_no_fx = idx.skippedFx; }

    var d = req.drone || {};
    var droneModeOn = !!idx.modes.D;
    var diagnostics = !!d.diagnostics;
    var diag = [];
    var variants = [], ctas = [];

    function finalize() {
      var all = top.concat(variants);
      variants.forEach(function (v) { v.score = scoreOf(v, base, cfg, criterion, nMax, opts.ratings); });
      all.sort(cmpRoutes);
      pinPass(all);
      response.routes = all.map(function (r) {
        var o = {};
        Object.keys(r).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = r[k]; });
        return o;
      });
      if (diagnostics && diag.length) response.drone_diagnostics = diag;
      if (ctas.length) response.drone_cta = ctas[0];
      if (!top.length) {
        var fb = fallbacks(idx, req, cfg);
        response.companies_on_direction = fb.companies;
        response.possible_links = fb.links;
      } else { response.companies_on_direction = []; response.possible_links = []; }
      return response;
    }

    if (!droneModeOn || !top.length) return Promise.resolve(finalize());
    if (d.allow === false) {
      if (diagnostics) top.forEach(function (r) { diag.push({ parent_route: r.route_id, reason: 'drone_disabled' }); });
      return Promise.resolve(finalize());
    }

    var budget = Math.min(cfg.drone_budget_cap_ms, cfg.drone_budget_share * cfg.route_time_limit_ms);
    var timedOut = false;
    return top.reduce(function (chain, parent) {
      return chain.then(function () {
        if (timedOut) return null;
        if (now() - t0 > budget) { timedOut = true; return null; }
        return postDrone(ctx, parent, opts.weather).then(function (r) {
          if (now() - t0 > budget) { timedOut = true; return null; }
          r.diag.forEach(function (x) { diag.push(x); });
          if (r.variant) variants.push(r.variant);
          if (r.cta) ctas.push(r.cta);
          if (r.parentWarn) parent._parentWarn = r.parentWarn;
          if (r.weatherUnknown) response.partial = true;
          return null;
        });
      });
    }, Promise.resolve()).then(function () {
      if (timedOut) {
        variants = []; ctas = []; diag = [];
        top.forEach(function (r) { delete r._parentWarn; });
        response.partial = true; response.drone_skipped = 'timeout';
        if (diagnostics) diag.push({ reason: 'timeout' });
        // partial після timeout не залежить від погоди: варіантів гілок це не змінює
      } else {
        // no_permit батьківського маршруту дописується ПІСЛЯ скорингу: score гілок не залежить від drone.allow (T24, T27)
        top.forEach(function (r) {
          if (r._parentWarn && r.warnings.indexOf(r._parentWarn) < 0) r.warnings.push(r._parentWarn);
        });
      }
      return finalize();
    });
  }

  return {
    search: search, prepare: prepare, syntheticWorld: syntheticWorld, DEMO_SCENARIOS: DEMO_SCENARIOS, haversineKm: haversineKm, DEFAULTS: DEFAULTS, DEMO_FX: DEMO_FX,
    MODE_UK: MODE_UK
  };
});
