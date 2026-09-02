#!/usr/bin/env python3
"""Друкує $id JSON-схеми. Окремий файл, а не python -c у workflow:
у рядку виду python -c "... s['$id'] ..." оболонка підставила б порожній рядок
замість $id, а варіант в одинарних лапках дає попередження shellcheck SC2016."""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "schemas/post-drone.schema.json"
try:
    with open(path, encoding="utf-8") as fh:
        print(json.load(fh).get("$id", ""))
except Exception:
    print("")
