#!/usr/bin/env python3
"""Перевіряє, що сама схема — валідна JSON Schema draft 2020-12.
Окремий крок CI: зламаний синтаксис схеми має давати зрозумілу помилку,
а не падіння всередині валідації прикладів (ТЗ, розділ A.13.3)."""
import json
import sys

from jsonschema import Draft202012Validator

path = sys.argv[1] if len(sys.argv) > 1 else "schemas/post-drone.schema.json"
with open(path, encoding="utf-8") as fh:
    schema = json.load(fh)
Draft202012Validator.check_schema(schema)
print(f"схема валідна: {path}")
