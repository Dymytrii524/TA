#!/usr/bin/env python3
"""Кожна заявка, яку віддає /api/v1/listings, має проходити
sprint-0-backend/schemas/listing.schema.json. Перевіряються всі 10 773 канонічні заявки
з експортера (тих самих функцій, що й у БД-імпортері), а не вибірка."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile

from jsonschema import Draft202012Validator

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

root = pathlib.Path(__file__).resolve().parents[2]
schema = json.loads((root / "sprint-0-backend" / "schemas" / "listing.schema.json").read_text(encoding="utf-8"))
validator = Draft202012Validator(schema)

with tempfile.TemporaryDirectory() as tmp:
    out = os.path.join(tmp, "listings.json")
    proc = subprocess.run([sys.executable, str(root / "sprint-0-backend" / "tools" / "export_canonical.py"), out],
                          capture_output=True, cwd=root)
    if proc.returncode != 0:
        print("експортер не запустився:", proc.stderr.decode("utf-8", "replace"))
        sys.exit(1)
    rows = json.loads(pathlib.Path(out).read_text(encoding="utf-8"))

# самоперевірка валідатора: зіпсована заявка має бути відхилена
broken = json.loads(json.dumps(rows[0]))
broken["price_amount"] = 12.5
if not list(validator.iter_errors(broken)):
    print("валідатор пропускає float у price_amount: перевірка марна")
    sys.exit(1)

bad = 0
for r in rows:
    errs = list(validator.iter_errors(r))
    if errs:
        bad += 1
        if bad <= 5:
            print("НЕ ПРОЙШЛО legacy_id", r.get("legacy_id"), "->", errs[0].message[:150])
ids = [r["id"] for r in rows]
if len(set(ids)) != len(ids):
    print("повторні uuid серед заявок")
    bad += 1
print(f"{len(rows) - bad} із {len(rows)} заявок валідні за listing.schema.json")
sys.exit(1 if bad else 0)
