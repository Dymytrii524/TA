#!/usr/bin/env python3
"""Витягує довідники з index.html (SPA) у машинно читані JSON-реєстри.

Джерело істини для Спринту 0 — саме index.html: тестовий набір із 7 120 заявок
уже прив'язаний до цих ідентифікаторів, тому БД мусить сідитись із них, а не з
нового вигаданого списку.

Вихід: seed/cities.json, seed/cargo_types.json, seed/currencies.json
"""
import json
import os
import re
import sys

MODES = ["auto", "rail", "sea", "air", "multi", "drone"]
KINDS = ["cargo", "transport"]
CONTINENTS = ["europe", "asia", "africa", "america", "australia"]


def _block(html: str, start_marker: str) -> str:
    i = html.index(start_marker)
    depth = 0
    for j in range(i, len(html)):
        if html[j] == "[":
            depth += 1
        elif html[j] == "]":
            depth -= 1
            if depth == 0:
                return html[i:j + 1]
    raise ValueError("незакритий масив: " + start_marker)


def parse_cities(html: str):
    block = _block(html, "var CITIES = [")
    out = []
    for m in re.finditer(r"\{id:\"(?P<id>[a-z0-9_-]+)\",(?P<rest>[^}]*)\}", block):
        rest = m.group("rest")

        def field(name, pattern=r'"([^"]*)"'):
            mm = re.search(name + r":\s*" + pattern, rest)
            return mm.group(1) if mm else None

        num = lambda name: float(re.search(name + r":\s*(-?[\d.]+)", rest).group(1))
        out.append({
            "id": m.group("id"),
            "name_uk": field("uk"), "name_en": field("en"),
            "name_pl": field("pl"), "name_de": field("de"),
            "lat": num("lat"), "lon": num("lon"),
            "country": field("country"),
            "icao": field("icao"),
            "continent": field("continent"),
        })
    return out


def parse_cargo(html: str):
    block = _block(html, "var CARGO_TYPES = [")
    out = []
    for m in re.finditer(r"\{id:\"(?P<id>[a-z0-9_-]+)\",(?P<rest>[^}]*)\}", block):
        rest = m.group("rest")
        field = lambda n: (re.search(n + r':\s*"([^"]*)"', rest) or [None, None])[1]
        out.append({
            "id": m.group("id"),
            "name_uk": field("uk"), "name_en": field("en"),
            "name_pl": field("pl"), "name_de": field("de"),
        })
    return out


def parse_currencies(html: str):
    block = _block(html, "var CURRENCIES = [")
    codes = re.findall(r'"([A-Z]{3,4})"', block)
    fmt_start = html.index("var CURRENCY_FORMAT = {")
    fmt_block = html[fmt_start:html.index("};", fmt_start)]
    fmt = {}
    for m in re.finditer(r"(\w+):\{sym:\"([^\"]*)\",pos:\"(pre|post)\"\}", fmt_block):
        fmt[m.group(1)] = {"symbol": m.group(2), "position": m.group(3)}
    return [{"code": c, "symbol": fmt.get(c, {}).get("symbol", c),
             "position": fmt.get(c, {}).get("position", "post"),
             "kind": "crypto" if c in ("USDC", "USDT", "EURC") else "fiat"} for c in codes]


def main(spa_path: str, out_dir: str) -> int:
    html = open(spa_path, encoding="utf-8").read()
    os.makedirs(out_dir, exist_ok=True)
    data = {
        "cities.json": parse_cities(html),
        "cargo_types.json": parse_cargo(html),
        "currencies.json": parse_currencies(html),
        "enums.json": {"modes": MODES, "kinds": KINDS, "continents": CONTINENTS},
    }
    for name, payload in data.items():
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
        n = len(payload) if isinstance(payload, list) else sum(len(v) for v in payload.values())
        print(f"{name}: {n}")
    return 0


if __name__ == "__main__":
    spa = sys.argv[1] if len(sys.argv) > 1 else "index.html"
    out = sys.argv[2] if len(sys.argv) > 2 else "seed"
    sys.exit(main(spa, out))
