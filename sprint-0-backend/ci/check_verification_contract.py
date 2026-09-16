#!/usr/bin/env python3
"""Перевірки артефактів модуля верифікації.

Групи:
  A. Каталог джерел узгоджений сам із собою
  B. Каталог перевірок посилається на наявні джерела
  C. OpenAPI розбирається, усі $ref розв'язуються, зокрема міжфайлові
  D. Схема приймає коректні форми і відхиляє некоректні
  E. Перерахування DDL збігаються зі схемою і каталогами
  F. Покриття: кожне джерело використане, кожен рівень має рішучу перевірку
  G. Навмисні мутації виявляються

Запуск: python3 ci/check_verification_contract.py
"""
import copy
import json
import os
import re
import sys

import jsonschema
import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FAILURES = []
PASSED = []


def check(label, ok_, detail=""):
    (PASSED if ok_ else FAILURES).append((label, detail))
    print(f"  [{'ok' if ok_ else 'ПРОВАЛ'}] {label}" + (f" — {detail}" if detail else ""))
    return ok_


def load(path):
    p = os.path.join(ROOT, path)
    with open(p, encoding="utf-8") as f:
        return yaml.safe_load(f) if path.endswith((".yaml", ".yml")) else json.load(f)


# --------------------------------------------------------------- валідатори

def validator_for(defn):
    schema = load("schemas/verification.schema.json")
    sub = copy.deepcopy(schema)
    sub.pop("oneOf", None)
    sub.update({"$ref": f"#/$defs/{defn}"})
    return jsonschema.Draft202012Validator(sub)


def valid(defn, doc):
    return not list(validator_for(defn).iter_errors(doc))


# ------------------------------------------------------------------ фікстури

NOW = "2026-09-10T12:00:00Z"
LATER = "2026-10-10T12:00:00Z"
UUID1 = "11111111-1111-4111-8111-111111111111"
UUID2 = "22222222-2222-4222-8222-222222222222"

GOOD_PASS = {
    "id": UUID1, "check_id": "identity.vat_active", "source_id": "vies",
    "status": "pass", "subject": {"identifier_kind": "vat_eu", "identifier_value": "PL5260250274",
                                  "country": "PL"},
    "findings": {"valid": True, "name": "MINISTERSTWO FINANSÓW"},
    "requested_at": NOW, "responded_at": NOW, "valid_until": LATER, "attempt": 1,
    "evidence": {"payload_sha256": "a" * 64, "content_type": "application/json",
                 "fetched_at": NOW, "storage_uri": "s3://ta-evidence/2026/09/x.json",
                 "payload_size": 512, "source_as_of": "2026-09-10",
                 "retention_until": "2031-09-10"},
}

GOOD_UNAVAILABLE = {
    "check_id": "risk.sanctions_ua", "source_id": "drs_nsdc", "status": "unavailable",
    "subject": {"identifier_kind": "edrpou", "identifier_value": "12345678", "country": "UA"},
    "findings": {}, "reason_code": "SOURCE_UNAUTHORIZED",
    "reason_text": "джерело повернуло 401", "requested_at": NOW, "responded_at": NOW,
}

GOOD_CASE = {
    "id": UUID1, "company_id": UUID2, "target_level": "L1", "status": "approved",
    "results": [GOOD_PASS], "blocking_unavailable": [],
    "decided_at": NOW, "expires_at": LATER, "created_at": NOW,
}

GOOD_CHANGE = {
    "id": UUID1, "company_id": UUID2, "kind": "bank_account",
    "old_value": "PL11 1010 1010 0000 0000 0000 0000",
    "new_value": "PL22 2020 2020 0000 0000 0000 0000",
    "source_id": "pl_white_list", "severity": "critical",
    "detected_at": NOW, "suspends_level": True,
}

GOOD_DOSSIER = {
    "company_id": UUID2, "display_name": "ТОВ Перевізник", "country": "UA", "level": "L1",
    "level_expires_at": LATER, "is_suspended": False, "suspend_reason": None,
    "checks": [{"check_id": "identity.vat_active", "title": "Номер ПДВ чинний",
                "status": "pass", "source_title": "VIES", "checked_at": NOW,
                "source_as_of": "2026-09-10", "is_stale": False,
                "source_url": "https://ec.europa.eu/taxation_customs/vies/",
                "reason_text": None}],
    "material_changes": [], "as_of": NOW,
}


def main():
    sources = load("seed/verification_sources.json")
    checks = load("seed/verification_checks.json")
    by_id = {s["id"]: s for s in sources}

    print("A. Каталог джерел")
    check("унікальні ідентифікатори", len(by_id) == len(sources),
          f"{len(sources)} джерел")
    check("юрисдикції у форматі ISO", all(re.fullmatch(r"[A-Z]{2}", s["jurisdiction"])
                                          for s in sources))
    check("додатний строк свіжості", all(s["ttl_days"] > 0 for s in sources))
    bad = [s["id"] for s in sources if s.get("blocking") and s.get("health") == "manual_only"]
    check("блокуюче джерело не буває суто ручним", not bad, ", ".join(bad))
    bad = [s["id"] for s in sources
           if s.get("endpoint") is None and s["kind"] not in ("manual", "state_registry")]
    check("джерело без ендпойнта позначене як ручне", not bad, ", ".join(bad))
    bad = [s["id"] for s in sources if s.get("cost_model") not in
           ("free", "per_query", "subscription")]
    check("модель вартості з відомого переліку", not bad, ", ".join(bad))
    bad = [s["id"] for s in sources if not s.get("notes")]
    check("кожне джерело має пояснення обмежень", not bad, ", ".join(bad))

    print("B. Каталог перевірок")
    check("унікальні ідентифікатори перевірок",
          len({c["id"] for c in checks}) == len(checks), f"{len(checks)} перевірок")
    bad = [c["id"] for c in checks if c["source_id"] not in by_id]
    check("усі посилання на джерела розв'язуються", not bad, ", ".join(bad))
    bad = [c["id"] for c in checks if c["required_for"] not in ("L1", "L2")]
    check("рівень перевірки не L0", not bad, ", ".join(bad))
    bad = [c["id"] for c in checks if not re.fullmatch(r"[a-z_]+\.[a-z_]+", c["id"])]
    check("формат ідентифікатора перевірки", not bad, ", ".join(bad))
    bad = [c["id"] for c in checks if c.get("jurisdictions") is not None
           and not all(re.fullmatch(r"[A-Z]{2}", j) for j in c["jurisdictions"])]
    check("юрисдикції перевірок у форматі ISO", not bad, ", ".join(bad))
    bad = [c["id"] for c in checks if len(c.get("description", "")) < 40]
    check("кожна перевірка описує критерій", not bad, ", ".join(bad))

    print("C. OpenAPI")
    spec = load("api/openapi-verification.yaml")
    refs, unresolved, external = [], [], []

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "$ref" and isinstance(v, str):
                    refs.append(v)
                    if v.startswith("#/"):
                        cur = spec
                        for part in v[2:].split("/"):
                            part = part.replace("~1", "/").replace("~0", "~")
                            if isinstance(cur, dict) and part in cur:
                                cur = cur[part]
                            else:
                                unresolved.append(v)
                                break
                    else:
                        external.append(v)
                else:
                    walk(v)
        elif isinstance(node, list):
            for i in node:
                walk(i)

    walk(spec)
    check("специфікація розбирається", spec.get("openapi", "").startswith("3.1"),
          spec.get("openapi"))
    check("локальні посилання розв'язуються", not unresolved,
          f"{len(refs)} посилань, {len(unresolved)} битих")

    schema_doc = load("schemas/verification.schema.json")
    ext_bad = []
    for r in external:
        path, _, frag = r.partition("#")
        target = os.path.normpath(os.path.join(ROOT, "api", path))
        if not os.path.exists(target):
            ext_bad.append(r)
            continue
        cur = schema_doc if target.endswith("verification.schema.json") else load(
            os.path.relpath(target, ROOT))
        for part in frag.lstrip("/").split("/"):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ext_bad.append(r)
                break
    check("міжфайлові посилання на схему розв'язуються", not ext_bad,
          f"{len(external)} посилань, {len(ext_bad)} битих")

    paths = spec.get("paths", {})
    no_idem = [p for p, ops in paths.items() if "post" in ops
               and not any(par.get("$ref", "").endswith("IdempotencyKey")
                           for par in ops["post"].get("parameters", []))]
    # multipart-подання документа ідемпотентності не потребує: файл сам є ключем
    no_idem = [p for p in no_idem if not p.endswith("/documents")]
    check("усі POST вимагають Idempotency-Key", not no_idem, ", ".join(no_idem))

    print("D. Схема канонічних форм")
    check("успішна перевірка приймається", valid("checkResult", GOOD_PASS))
    check("недоступне джерело приймається", valid("checkResult", GOOD_UNAVAILABLE))
    check("справа приймається", valid("verificationCase", GOOD_CASE))
    check("зміна реквізиту приймається", valid("requisiteChange", GOOD_CHANGE))
    check("досьє приймається", valid("dossier", GOOD_DOSSIER))

    print("E. Перерахування DDL")
    ddl = open(os.path.join(ROOT, "db/migrations/002_verification.sql"), encoding="utf-8").read()

    def ddl_enum(name):
        m = re.search(rf"CREATE TYPE {name} AS ENUM \((.*?)\);", ddl, re.S)
        if not m:
            return set()
        # Коментарі українською містять апостроф, тому їх треба зрізати до розбору
        # літералів, інакше текст коментаря читається як значення.
        body = re.sub(r"--[^\n]*", "", m.group(1))
        return set(re.findall(r"'([^']+)'", body))

    defs = schema_doc["$defs"]
    pairs = [
        ("check_status", set(defs["checkStatus"]["enum"])),
        ("case_status", set(defs["caseStatus"]["enum"])),
        ("change_severity", set(defs["severity"]["enum"])),
        ("requisite_kind", set(defs["requisiteKind"]["enum"])),
        ("identifier_kind", set(defs["identifierKind"]["enum"])),
    ]
    for name, expected in pairs:
        got = ddl_enum(name)
        check(f"{name} збігається зі схемою", got == expected,
              f"тільки в DDL: {sorted(got - expected)}, тільки в схемі: {sorted(expected - got)}"
              if got != expected else f"{len(got)} значень")

    ddl_kinds = ddl_enum("source_kind")
    cat_kinds = {s["kind"] for s in sources}
    check("види джерел у DDL покривають каталог", cat_kinds <= ddl_kinds,
          f"поза DDL: {sorted(cat_kinds - ddl_kinds)}")
    ddl_health = ddl_enum("source_health")
    cat_health = {s.get("health", "live") for s in sources}
    check("стани джерел у DDL покривають каталог", cat_health <= ddl_health,
          f"поза DDL: {sorted(cat_health - ddl_health)}")

    print("F. Покриття")
    used = {c["source_id"] for c in checks}
    # Джерело вважається задіяним, якщо на нього спирається перевірка або
    # якщо воно явно оголошене альтернативою задіяному (вибір постачальника
    # — комерційне рішення, контракт конектора однаковий).
    unused = sorted(sid for sid in by_id
                    if sid not in used and by_id[sid].get("alternative_to") not in used)
    check("кожне джерело використане або оголошене альтернативою", not unused,
          ", ".join(unused))
    bad = [s["id"] for s in sources if s.get("alternative_to")
           and by_id.get(s["alternative_to"], {}).get("kind") != s["kind"]]
    check("альтернатива того самого виду", not bad, ", ".join(bad))
    for lvl in ("L1", "L2"):
        decisive = [c for c in checks if c["required_for"] == lvl and c["is_decisive"]]
        check(f"рівень {lvl} має рішучу перевірку", bool(decisive),
              f"{len(decisive)} шт.")
    monitored = [c for c in checks if c["id"].startswith("monitor.")]
    check("моніторинг реквізитів входить у L2",
          all(c["required_for"] == "L2" for c in monitored) and bool(monitored),
          f"{len(monitored)} перевірки")
    # Мета напряму: зміна банківського рахунку мусить бути підйомною хоча б
    # з одного джерела, інакше моніторинг реквізитів — декларація.
    acct = [s["id"] for s in sources if "accountNumbers" in (s.get("notes") or "")
            or "рахунк" in (s.get("notes") or "")]
    check("є джерело, що публікує банківські рахунки", bool(acct), ", ".join(acct))

    print("G. Навмисні мутації")
    mutations = [
        ("unavailable зі знахідками",
         lambda: valid("checkResult", {**GOOD_UNAVAILABLE, "findings": {"valid": True}})),
        ("pass без строку дії",
         lambda: valid("checkResult", {k: v for k, v in GOOD_PASS.items() if k != "valid_until"})),
        ("fail без коду причини",
         lambda: valid("checkResult", {**GOOD_PASS, "status": "fail"})),
        ("pending з часом відповіді",
         lambda: valid("checkResult", {**GOOD_PASS, "status": "pending",
                                       "reason_code": None})),
        ("невідомий статус",
         lambda: valid("checkResult", {**GOOD_PASS, "status": "probably_ok"})),
        ("схвалення з невиконаною блокуючою перевіркою",
         lambda: valid("verificationCase", {**GOOD_CASE,
                                            "blocking_unavailable": ["risk.sanctions"]})),
        ("відмова без причини",
         lambda: valid("verificationCase", {**GOOD_CASE, "status": "rejected"})),
        ("зміна рахунку зі статусом info",
         lambda: valid("requisiteChange", {**GOOD_CHANGE, "severity": "info",
                                           "suspends_level": False})),
        ("критична зміна, що не призупиняє рівень",
         lambda: valid("requisiteChange", {**GOOD_CHANGE, "kind": "legal_address",
                                           "suspends_level": False})),
        ("рівень L1 без строку дії в досьє",
         lambda: valid("dossier", {**GOOD_DOSSIER, "level_expires_at": None})),
        ("призупинення без причини",
         lambda: valid("dossier", {**GOOD_DOSSIER, "is_suspended": True})),
        ("хеш доказу неповної довжини",
         lambda: valid("checkResult", {**GOOD_PASS,
                                       "evidence": {**GOOD_PASS["evidence"],
                                                    "payload_sha256": "a" * 63}})),
    ]
    caught = 0
    for name, fn in mutations:
        accepted = fn()
        if accepted:
            check(f"мутація «{name}»", False, "схема прийняла хибну форму")
        else:
            caught += 1
    check("навмисні мутації виявлено", caught == len(mutations),
          f"{caught} із {len(mutations)}")

    print("-" * 60)
    total = len(PASSED) + len(FAILURES)
    if FAILURES:
        print(f"ПРОВАЛЕНО {len(FAILURES)} із {total}:")
        for label, detail in FAILURES:
            print(f"  - {label}: {detail}")
        return 1
    print(f"Усі {total} перевірок пройдено.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
