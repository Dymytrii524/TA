#!/usr/bin/env python3
"""Відповіді рушія SEARCH на сценаріях T16-T27 мають проходити JSON Schema
контракту POST_DRONE (schemas/post-drone.schema.json): рушій не має права
видавати те, що контракт забороняє."""
import json
import pathlib
import subprocess
import sys

from jsonschema import Draft202012Validator

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

root = pathlib.Path(__file__).resolve().parents[2]
schema = json.loads((root / "schemas" / "post-drone.schema.json").read_text(encoding="utf-8"))
validator = Draft202012Validator(schema)

proc = subprocess.run(["node", str(root / "search" / "tests" / "dump_scenarios.js")],
                      capture_output=True, cwd=root)
if proc.returncode != 0:
    print("рушій не запустився:", proc.stderr.decode("utf-8", "replace"))
    sys.exit(1)
responses = json.loads(proc.stdout.decode("utf-8"))

bad = 0
for name, resp in responses.items():
    errors = sorted(validator.iter_errors(resp), key=lambda e: list(e.path))
    if errors:
        bad += 1
        print(f"НЕ ПРОЙШЛО {name}")
        for e in errors[:5]:
            print("   ", "/".join(map(str, e.path)) or "(корінь)", "->", e.message[:160])
    else:
        print(f"ok   {name}")
print(f"\n{len(responses) - bad} із {len(responses)} відповідей валідні за схемою")
sys.exit(1 if bad else 0)
