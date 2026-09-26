#!/usr/bin/env python3
"""Записує канонічні заявки (listing.schema.json) у server/data/listings.canonical.json.

Використовує ті самі read_legacy_listings і to_canonical, що й імпортер у БД, тож
локальний сервер /api/v1 віддає рівно те, що потрапило б у PostgreSQL. Файл генерується,
а не зберігається в git (див. .gitignore).

Запуск із кореня репозиторію:
    python sprint-0-backend/tools/export_canonical.py [вихідний_файл]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_legacy as il  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "server", "data", "listings.canonical.json")

cities = il.load_cities(os.path.join(ROOT, "sprint-0-backend", "seed"))
legacy = il.read_legacy_listings(os.path.join(ROOT, "index.html"), os.path.join(ROOT, "test-data"))
rows = [il.to_canonical(r, cities) for r in legacy]
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(rows, fh, ensure_ascii=False, separators=(",", ":"))
print(f"записано {len(rows)} заявок -> {out_path}")
