#!/usr/bin/env python3
"""Імпорт заявок із SPA-формату в канонічний формат Спринту 0.

Дві функції, які використовує і бекенд-імпортер, і CI:
  * read_legacy_listings(spa_path, test_data_dir) -> list[dict]  — читання джерел
  * to_canonical(legacy) -> dict                                  — детерміноване перетворення

Ключові правила перетворення (вони ж — рішення ТЗ):
  1. weight у legacy — тонни для всіх видів транспорту, крім mode=drone, де
     weightUnit='kg'. Канонічне поле weight_kg завжди в кілограмах.
  2. Гроші стають десятковим рядком, ніколи float.
  3. company (рядок) стає сутністю: UUID v5 від нормалізованої назви, рівень L0.
  4. id (ціле) зберігається як legacy_id; первинний ключ — UUID v5 від нього.
  5. Поле continent із test-data не переноситься: континент визначається містом,
     а не заявкою; дублювати джерело істини не можна.
"""
import glob
import json
import os
import re
import uuid
from decimal import Decimal

NS_LISTING = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")
NS_COMPANY = uuid.UUID("1b671a64-40d5-491e-99b0-da01ff1f3341")

KG_PER_TONNE = Decimal(1000)


# ----------------------------------------------------------------- читання джерел
def _strip_js_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"^\s*//.*$", "", src, flags=re.M)


def _js_array_to_json(block: str) -> list:
    block = _strip_js_comments(block)
    block = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', block)
    block = re.sub(r",\s*([\]}])", r"\1", block)
    return json.loads(block)


def _balanced_array(html: str, marker: str) -> str:
    i = html.index(marker) + marker.index("[")
    depth = 0
    for j in range(i, len(html)):
        if html[j] == "[":
            depth += 1
        elif html[j] == "]":
            depth -= 1
            if depth == 0:
                return html[i:j + 1]
    raise ValueError("незакритий масив " + marker)


def read_spa_listings(spa_path: str) -> list:
    html = open(spa_path, encoding="utf-8").read()
    return _js_array_to_json(_balanced_array(html, "var LISTINGS = ["))


def read_test_data(test_dir: str) -> list:
    """Лише пофайлові набори за видами транспорту.

    Континентальні агрегати (listings-<continent>.json) містять ті самі заявки,
    тому їх пропускаємо — інакше отримаємо подвійний облік 7 120 записів.
    """
    seen, out = set(), []
    for path in sorted(glob.glob(os.path.join(test_dir, "listings-*.json"))):
        name = os.path.basename(path)
        if len(name.split("-")) < 3:  # listings-europe.json — агрегат
            continue
        for row in json.load(open(path, encoding="utf-8"))["listings"]:
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            out.append(row)
    return out


def read_legacy_listings(spa_path: str, test_dir: str) -> list:
    rows = read_spa_listings(spa_path)
    ids = {r["id"] for r in rows}
    for r in read_test_data(test_dir):
        if r["id"] not in ids:
            rows.append(r)
            ids.add(r["id"])
    return rows


# ----------------------------------------------------------------- перетворення
def _dec(value, places: int = 3) -> str:
    q = Decimal(str(value)).quantize(Decimal(1).scaleb(-places))
    return format(q.normalize() if q == q.to_integral() else q, "f")


def company_uuid(name: str) -> str:
    return str(uuid.uuid5(NS_COMPANY, " ".join(name.split()).casefold()))


def to_canonical(legacy: dict, cities: dict, now: str = "2026-09-10T00:00:00Z") -> dict:
    mode = legacy["mode"]
    weight = Decimal(str(legacy["weight"]))
    if mode == "drone":
        if legacy.get("weightUnit") != "kg":
            raise ValueError(f"заявка {legacy['id']}: дрон без weightUnit=kg")
        weight_kg = weight
    else:
        if "weightUnit" in legacy:
            raise ValueError(f"заявка {legacy['id']}: weightUnit поза mode=drone")
        weight_kg = weight * KG_PER_TONNE

    origin, dest = cities[legacy["from"]], cities[legacy["to"]]
    out = {
        "id": str(uuid.uuid5(NS_LISTING, str(legacy["id"]))),
        "legacy_id": legacy["id"],
        "kind": legacy["kind"],
        "mode": mode,
        "components": legacy.get("components") if mode == "multi" else None,
        "origin_city_id": legacy["from"],
        "destination_city_id": legacy["to"],
        "origin_country": origin["country"],
        "destination_country": dest["country"],
        "is_cross_border": origin["country"] != dest["country"],
        "ready_date": legacy["date"],
        "cargo_type_id": legacy["cargo"],
        "weight_kg": _dec(weight_kg),
        "volume_m3": _dec(legacy["volume"]) if legacy.get("volume") is not None else None,
        "price_amount": _dec(legacy["price"], 2),
        "price_currency": legacy["currency"],
        "price_kind": "fixed",
        "company": {
            "id": company_uuid(legacy["company"]),
            "display_name": legacy["company"],
            "verification_level": "L0",
            "verified_at": None,
        },
        "drone": None,
        "status": "active",
        "source": "import",
        "expires_at": None,
        "created_at": now,
        "updated_at": now,
    }
    if mode == "drone":
        out["drone"] = {
            "range_km": _dec(legacy["rangeKm"], 2),
            "max_payload_kg": _dec(legacy["maxPayloadKg"], 2),
            "drone_type": legacy["droneType"],
            "flight_permit": bool(legacy["flightPermit"]),
        }
    return out


def load_cities(seed_dir: str) -> dict:
    rows = json.load(open(os.path.join(seed_dir, "cities.json"), encoding="utf-8"))
    return {c["id"]: c for c in rows}


if __name__ == "__main__":
    import sys
    spa, test_dir, seed_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    cities = load_cities(seed_dir)
    rows = [to_canonical(r, cities) for r in read_legacy_listings(spa, test_dir)]
    print(json.dumps(rows[:2], ensure_ascii=False, indent=1))
    print(f"перетворено: {len(rows)}")
