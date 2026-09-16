#!/usr/bin/env python3
"""Живий зонд джерел верифікації.

Робить справжні запити до реєстрів і повідомляє їхній фактичний стан.
Це не тест продукту, а тест припущень: каталог у seed/verification_sources.json
має відповідати тому, що джерела реально роблять сьогодні.

Зонд ніколи не перетворює недоступність на успіх. Кожне джерело отримує один
із станів live, degraded, stale, down, manual_only, needs_key.

Запуск: python3 tools/probe_sources.py [--json out.json]
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
UA = "Mozilla/5.0 (compatible; TransAtlas-SourceProbe/1.0)"
TIMEOUT = 25
CTX = ssl.create_default_context()


def call(url, method="GET", body=None, headers=None):
    req = urllib.request.Request(url, method=method,
                                 data=json.dumps(body).encode() if body else None)
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "application/json")
    if body:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=CTX) as resp:
            return resp.status, resp.read(400_000), int((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(20_000), int((time.time() - t0) * 1000)
    except Exception as e:  # мережа, DNS, TLS, таймаут
        return None, str(e).encode(), int((time.time() - t0) * 1000)


# ------------------------------------------------------------------ зонди

def probe_vies():
    """Відомий чинний номер ПДВ: Міністерство фінансів Польщі."""
    st, body, ms = call(
        "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number",
        method="POST", body={"countryCode": "PL", "vatNumber": "5260250274"})
    if st != 200:
        return "down", ms, f"HTTP {st}"
    d = json.loads(body)
    if d.get("valid") is not True:
        return "degraded", ms, "відомий чинний номер визнано недійсним"
    # Окремо: скільки держав-членів зараз недоступні. Це і є причина,
    # через яку статус unavailable мусить існувати в моделі.
    st2, body2, _ = call("https://ec.europa.eu/taxation_customs/vies/rest-api/check-status")
    down = []
    if st2 == 200:
        d2 = json.loads(body2)
        down = [c["countryCode"] for c in d2.get("countries", [])
                if c.get("availability") != "Available"]
    note = f"valid=true, назва «{d.get('name', '')[:40]}»"
    if down:
        note += f"; недоступні держави-члени: {','.join(down)}"
    return ("degraded" if down else "live"), ms, note


def probe_pl_white_list():
    st, body, ms = call(
        "https://wl-api.mf.gov.pl/api/search/nip/5260250274?date=2026-09-09")
    if st != 200:
        return "down", ms, f"HTTP {st}"
    subj = json.loads(body)["result"]["subject"]
    accounts = subj.get("accountNumbers") or []
    return "live", ms, (f"status={subj.get('statusVat')}, "
                        f"рахунків у реєстрі: {len(accounts)}")


def probe_pl_krs():
    st, body, ms = call(
        "https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/0000028860?rejestr=P&format=json")
    if st == 204:
        return "degraded", ms, "204 для відомого номера"
    if st != 200:
        return "down", ms, f"HTTP {st}"
    head = json.loads(body)["odpis"]["naglowekA"]
    return "live", ms, (f"stanZDnia={head.get('stanZDnia')}, "
                        f"останній запис {head.get('dataOstatniegoWpisu')}")


def probe_drs_nsdc():
    st, _, ms = call("https://api-drs.nsdc.gov.ua/v2/subjects?subjectType=legal&limit=1")
    if st == 401:
        return "needs_key", ms, "401 Unauthorized: потрібен ключ від НСДЦ"
    if st == 200:
        return "live", ms, "відкрито без ключа"
    return "down", ms, f"HTTP {st}"


def probe_drs_spec():
    st, body, ms = call("https://api-drs.nsdc.gov.ua/swagger-json")
    if st != 200:
        return "down", ms, f"HTTP {st}"
    d = json.loads(body)
    paths = list(d.get("paths", {}))
    has_delta = any("new-decrees" in p for p in paths)
    return "live", ms, (f"специфікація {d['info'].get('version')}, {len(paths)} шляхів, "
                        f"дельта-ендпойнт: {'є' if has_delta else 'немає'}")


def probe_opensanctions():
    st, _, ms = call("https://api.opensanctions.org/match/default",
                     method="POST", body={"queries": {"q1": {"schema": "Company",
                                                             "properties": {"name": ["Test"]}}}})
    if st in (401, 403):
        return "needs_key", ms, f"HTTP {st}: потрібен ключ або власне розгортання yente"
    if st == 200:
        return "live", ms, "відповідає без ключа"
    return "down", ms, f"HTTP {st}"


def probe_dsbt():
    st, body, ms = call("https://middleware.dsbt.gov.ua/lc/licenses?page=1&limit=1")
    if st != 200:
        return "down", ms, f"HTTP {st}"
    is_html = body.lstrip()[:15].lower().startswith(b"<!doctype") or b"<html" in body[:400].lower()
    if is_html:
        return "stale", ms, "віддає HTML, машинного інтерфейсу немає"
    return "live", ms, "JSON"


def probe_nais():
    st, _, ms = call("https://nais.gov.ua/pages/api")
    if st == 200:
        return "needs_key", ms, "сторінка доступна; доступ до API за договором"
    return "down", ms, f"HTTP {st}"


PROBES = {
    "vies": probe_vies,
    "pl_white_list": probe_pl_white_list,
    "pl_krs": probe_pl_krs,
    "drs_nsdc": probe_drs_nsdc,
    "drs_nsdc_spec": probe_drs_spec,
    "opensanctions": probe_opensanctions,
    "dsbt_licenses": probe_dsbt,
    "edr_nais": probe_nais,
}

# Джерела, які принципово не мають машинного інтерфейсу.
MANUAL = {"erru", "control_payment", "domain_email"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", dest="out")
    args = ap.parse_args()

    catalog = {s["id"]: s for s in json.load(
        open(os.path.join(ROOT, "seed/verification_sources.json"), encoding="utf-8"))}

    rows = []
    for sid, fn in PROBES.items():
        health, ms, note = fn()
        rows.append({"source": sid, "health": health, "latency_ms": ms, "note": note})
        print(f"{sid:<16} {health:<11} {ms:>6} мс  {note}")

    for sid in sorted(MANUAL):
        rows.append({"source": sid, "health": "manual_only", "latency_ms": 0,
                     "note": "машинного інтерфейсу не існує"})
        print(f"{sid:<16} {'manual_only':<11} {0:>6} мс  машинного інтерфейсу не існує")

    print("-" * 70)
    # Перевірка узгодженості каталогу зі спостереженням: джерело, позначене
    # як таке, що не потребує ключа, не має відповідати 401.
    problems = []
    for r in rows:
        src = catalog.get(r["source"])
        if not src:
            continue
        if r["health"] == "needs_key" and not src["requires_key"]:
            problems.append(f"{r['source']}: каталог каже «без ключа», джерело вимагає ключ")
        if r["health"] == "live" and src.get("health") == "manual_only":
            problems.append(f"{r['source']}: каталог каже «лише вручну», а джерело відповідає")
        if r["health"] == "down" and src.get("blocking"):
            problems.append(f"{r['source']}: блокуюче джерело недоступне — "
                            f"позитивні рішення для цієї юрисдикції мають бути зупинені")

    live = sum(1 for r in rows if r["health"] == "live")
    print(f"живих {live}, потребують ключа "
          f"{sum(1 for r in rows if r['health'] == 'needs_key')}, "
          f"деградованих {sum(1 for r in rows if r['health'] in ('degraded', 'stale'))}, "
          f"недоступних {sum(1 for r in rows if r['health'] == 'down')}, "
          f"лише вручну {sum(1 for r in rows if r['health'] == 'manual_only')}")
    for p in problems:
        print("  розбіжність з каталогом:", p)

    if args.out:
        json.dump({"probed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "results": rows, "catalog_mismatches": problems},
                  open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
