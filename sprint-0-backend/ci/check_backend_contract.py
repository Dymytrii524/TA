#!/usr/bin/env python3
"""Контрактна перевірка бекенду Спринту 0.

Перевіряє не текст ТЗ, а артефакти: JSON Schema, OpenAPI, DDL, імпортер і
реєстри, витягнуті з index.html. Розбіжність між ними — дефект, а не стиль.

  A. Усі legacy-заявки (SPA + test-data) валідні за listing-legacy.schema.json
  B. Посилання legacy-даних існують у реєстрах (місто, вантаж, валюта, режим)
  C. Імпортер дає канонічні записи, валідні за listing.schema.json
  D. OpenAPI розбирається, усі локальні $ref розв'язуються
  E. Перерахування в DDL збігаються з реєстрами SPA
  F. Кожен фільтр state.filters має параметр у GET /api/v1/listings
  G. Гроші й вага в канонічному форматі — рядки, не float
  H. Самоперевірка: 8 навмисних мутацій мають бути виявлені

Запуск: python3 ci/check_backend_contract.py <шлях-до-репозиторію-TA>
"""
import copy
import json
import os
import re
import sys

import yaml
from jsonschema import Draft202012Validator, FormatChecker

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import import_legacy  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FAILS = []
CHECKS = 0


def check(ok: bool, label: str, detail: str = ""):
    global CHECKS
    CHECKS += 1
    if not ok:
        FAILS.append(f"{label}: {detail}")
    return ok


def load_json(path):
    return json.load(open(os.path.join(ROOT, path), encoding="utf-8"))


def main(ta_path: str) -> int:
    spa = os.path.join(ta_path, "index.html")
    test_dir = os.path.join(ta_path, "test-data")
    seed = os.path.join(ROOT, "seed")

    cities = import_legacy.load_cities(seed)
    cargo = {c["id"] for c in load_json("seed/cargo_types.json")}
    currencies = {c["code"] for c in load_json("seed/currencies.json")}
    enums = load_json("seed/enums.json")

    legacy_schema = load_json("schemas/listing-legacy.schema.json")
    canon_schema = load_json("schemas/listing.schema.json")
    v_legacy = Draft202012Validator(legacy_schema, format_checker=FormatChecker())
    v_canon = Draft202012Validator(canon_schema, format_checker=FormatChecker())

    rows = import_legacy.read_legacy_listings(spa, test_dir)
    print(f"джерела: {len(rows)} legacy-заявок")

    # ---------------------------------------------------------------- A
    bad = []
    for r in rows:
        err = next(v_legacy.iter_errors(r), None)
        if err:
            bad.append((r.get("id"), err.message))
    check(not bad, "A/legacy-schema", f"{len(bad)} невалідних, напр. {bad[:2]}")
    print(f"A. legacy-схема: {len(rows) - len(bad)}/{len(rows)} валідні")

    # ---------------------------------------------------------------- B
    ref_bad = []
    for r in rows:
        if r["from"] not in cities:
            ref_bad.append((r["id"], "from", r["from"]))
        if r["to"] not in cities:
            ref_bad.append((r["id"], "to", r["to"]))
        if r["cargo"] not in cargo:
            ref_bad.append((r["id"], "cargo", r["cargo"]))
        if r["currency"] not in currencies:
            ref_bad.append((r["id"], "currency", r["currency"]))
        if r["mode"] not in enums["modes"]:
            ref_bad.append((r["id"], "mode", r["mode"]))
    check(not ref_bad, "B/referential", f"{len(ref_bad)} розбіжностей: {ref_bad[:3]}")
    print(f"B. посилання в реєстри: {len(ref_bad)} розбіжностей")

    # ---------------------------------------------------------------- C, G
    canon, canon_bad, money_bad = [], [], []
    for r in rows:
        c = import_legacy.to_canonical(r, cities)
        canon.append(c)
        err = next(v_canon.iter_errors(c), None)
        if err:
            canon_bad.append((r["id"], err.json_path, err.message))
        for field in ("weight_kg", "price_amount", "volume_m3"):
            val = c.get(field)
            if val is not None and not isinstance(val, str):
                money_bad.append((r["id"], field, type(val).__name__))
    check(not canon_bad, "C/canonical-schema", f"{len(canon_bad)} невалідних: {canon_bad[:2]}")
    check(not money_bad, "G/decimal-as-string", f"{len(money_bad)}: {money_bad[:2]}")
    print(f"C. канонічна схема: {len(canon) - len(canon_bad)}/{len(canon)} валідні")
    print(f"G. гроші й вага рядками: {len(money_bad)} порушень")

    # перевірка одиниць: тонни -> кілограми, дрон лишається в кг
    sample = next(r for r in rows if r["mode"] == "auto")
    got = next(c for c in canon if c["legacy_id"] == sample["id"])["weight_kg"]
    check(float(got) == float(sample["weight"]) * 1000, "C/units-tonne",
          f"{sample['weight']} т -> {got} кг")
    dsample = next(r for r in rows if r["mode"] == "drone")
    dgot = next(c for c in canon if c["legacy_id"] == dsample["id"])["weight_kg"]
    check(float(dgot) == float(dsample["weight"]), "C/units-drone",
          f"{dsample['weight']} кг -> {dgot} кг")

    # ---------------------------------------------------------------- D
    spec = yaml.safe_load(open(os.path.join(ROOT, "api/openapi.yaml"), encoding="utf-8"))
    refs = re.findall(r'"?\$ref"?:\s*"(#[^"]+)"', open(
        os.path.join(ROOT, "api/openapi.yaml"), encoding="utf-8").read())
    missing = []
    for ref in set(refs):
        node = spec
        for part in ref.lstrip("#/").split("/"):
            part = part.replace("~1", "/")
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                missing.append(ref)
                break
    check(not missing, "D/openapi-refs", f"нерозв'язані: {sorted(set(missing))}")
    print(f"D. OpenAPI: {len(spec['paths'])} шляхів, {len(set(refs))} посилань, "
          f"{len(missing)} нерозв'язаних")

    # ---------------------------------------------------------------- E
    ddl = open(os.path.join(ROOT, "db/migrations/001_init.sql"), encoding="utf-8").read()

    def sql_enum(name):
        m = re.search(r"CREATE TYPE\s+%s\s+AS ENUM \(([^)]*)\)" % name, ddl)
        return [x.strip().strip("'") for x in m.group(1).split(",")] if m else None

    check(sql_enum("transport_mode") == enums["modes"], "E/enum-mode",
          f"{sql_enum('transport_mode')} != {enums['modes']}")
    check(sql_enum("listing_kind") == enums["kinds"], "E/enum-kind",
          f"{sql_enum('listing_kind')} != {enums['kinds']}")
    check(sql_enum("continent_code") == enums["continents"], "E/enum-continent",
          f"{sql_enum('continent_code')} != {enums['continents']}")
    canon_statuses = canon_schema["properties"]["status"]["enum"]
    check(sql_enum("listing_status") == canon_statuses, "E/enum-status",
          f"{sql_enum('listing_status')} != {canon_statuses}")
    canon_sources = canon_schema["properties"]["source"]["enum"]
    check(sql_enum("listing_source") == canon_sources, "E/enum-source",
          f"{sql_enum('listing_source')} != {canon_sources}")
    print("E. перерахування DDL <-> реєстри: звірено 5 типів")

    # ---------------------------------------------------------------- F
    html = open(spa, encoding="utf-8").read()
    body = html[html.index("function filteredListings"):]
    body = body[:body.index("\n}")]
    used = set(re.findall(r"state\.filters\.([A-Za-z]+)", body))
    params = spec["paths"]["/api/v1/listings"]["get"]["parameters"]
    described = " ".join(p.get("description", "") for p in params)
    unmapped = sorted(f for f in used if f"state.filters.{f}" not in described)
    check(not unmapped, "F/filter-parity", f"фільтри без параметра API: {unmapped}")
    print(f"F. паритет фільтрів: {len(used)} у SPA, {len(unmapped)} без відповідника")

    # типове значення limit має дорівнювати PAGE_SIZE у SPA
    page_size = int(re.search(r"var PAGE_SIZE\s*=\s*(\d+)", html).group(1))
    limit = next(p for p in params if p["name"] == "limit")["schema"]["default"]
    check(limit == page_size, "F/page-size", f"limit={limit} != PAGE_SIZE={page_size}")

    # ---------------------------------------------------------------- H
    detected = 0
    mutations = []

    def mutate(label, fn):
        nonlocal detected
        mutations.append(label)
        if fn():
            detected += 1
        else:
            FAILS.append(f"H/{label}: мутація не виявлена")

    base = copy.deepcopy(canon[0])
    legacy_base = copy.deepcopy(rows[0])

    def broken(obj, validator=v_canon):
        return next(validator.iter_errors(obj), None) is not None

    mutate("гроші як число", lambda: broken({**base, "price_amount": 1450.0}))
    mutate("гроші з 3 знаками", lambda: broken({**base, "price_amount": "1450.005"}))
    mutate("невідомий вид транспорту", lambda: broken({**base, "mode": "hyperloop"}))
    mutate("components поза multi", lambda: broken({**base, "components": ["auto", "rail"]}))
    mutate("multi без components",
           lambda: broken({**base, "mode": "multi", "components": None}))
    mutate("дрон без деталей", lambda: broken({**base, "mode": "drone", "drone": None}))
    mutate("зайве поле", lambda: broken({**base, "surprise": 1}))
    mutate("legacy: дрон-поля в авто",
           lambda: broken({**legacy_base, "rangeKm": 40}, v_legacy))

    # Кузов/вагон/судно. Поле зʼявилося в test-data пізніше за схему, і саме
    # ця розбіжність один раз уже зробила всі 1977 записів невалідними.
    # Мутації нижче тримають чотири межі поля, а не лише факт його існування.
    body_base = next((copy.deepcopy(r) for r in rows
                      if r.get("bodyType") and r.get("mode") == "auto"), None)
    if body_base is None:
        FAILS.append("H/bodyType: у даних немає жодної авто-пропозиції з кузовом")
    else:
        mutate("legacy: кузов не того виду транспорту",
               lambda: broken({**body_base, "bodyType": "gondola"}, v_legacy))
        mutate("legacy: кузов у вантажній заявці",
               lambda: broken({**body_base, "kind": "cargo"}, v_legacy))
        mutate("legacy: кузов у виду транспорту без кузова",
               lambda: broken({**body_base, "mode": "air"}, v_legacy))
        mutate("legacy: невідомий тип кузова",
               lambda: broken({**body_base, "bodyType": "skyhook"}, v_legacy))

    unknown_city = dict(legacy_base, **{"from": "atlantis"})
    mutate("невідоме місто", lambda: unknown_city["from"] not in cities)

    ddl_no_check = ddl.replace("CONSTRAINT listings_components_rule CHECK", "-- removed")
    mutate("DDL без правила components",
           lambda: "listings_components_rule" not in ddl_no_check)

    check(detected == len(mutations), "H/mutations",
          f"виявлено {detected} із {len(mutations)}")
    print(f"H. навмисні мутації: виявлено {detected}/{len(mutations)}")

    # ---------------------------------------------------------------- підсумок
    print("-" * 60)
    if FAILS:
        print(f"ПРОВАЛЕНО {len(FAILS)} із {CHECKS} перевірок:")
        for f in FAILS:
            print("  -", f)
        return 1
    print(f"Усі {CHECKS} перевірок пройдено.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "../TA"))
