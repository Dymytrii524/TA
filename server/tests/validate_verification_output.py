#!/usr/bin/env python3
"""Справи, які збирає модуль верифікації, мають проходити JSON Schema
sprint-0-backend/schemas/verification.schema.json (verificationCase): модуль не має права
видавати те, що контракт забороняє, зокрема unavailable з findings, статус без reason_code,
схвалення з непорожнім blocking_unavailable."""
import json
import pathlib
import subprocess
import sys

from jsonschema import Draft202012Validator

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

root = pathlib.Path(__file__).resolve().parents[2]
schema = json.loads((root / "sprint-0-backend" / "schemas" / "verification.schema.json").read_text(encoding="utf-8"))
validator = Draft202012Validator({"$ref": "#/$defs/verificationCase", "$defs": schema["$defs"]})

proc = subprocess.run(["node", str(root / "server" / "tests" / "dump_verification_cases.js")], capture_output=True, cwd=root)
if proc.returncode != 0:
    print("dump не запустився:", proc.stderr.decode("utf-8", "replace"))
    sys.exit(1)
cases = json.loads(proc.stdout.decode("utf-8"))

# самоперевірка: валідатор справді ловить порушення
broken = json.loads(json.dumps(cases[0]))
broken["results"][0]["status"] = "unavailable"
broken["results"][0]["findings"] = {"x": 1}
if not list(validator.iter_errors(broken)):
    print("валідатор не ловить unavailable з findings: перевірка марна")
    sys.exit(1)
broken = json.loads(json.dumps(cases[1]))
broken["blocking_unavailable"] = ["risk.sanctions"]
if not list(validator.iter_errors(broken)):
    print("валідатор не ловить схвалення з blocking_unavailable")
    sys.exit(1)

bad = 0
for c in cases:
    errs = sorted(validator.iter_errors(c), key=lambda e: list(e.path))
    label = f"{c['status']:13} {c['target_level']} {len(c['results'])} перевірок"
    if errs:
        bad += 1
        print("НЕ ПРОЙШЛО", label)
        for e in errs[:5]:
            print("   ", "/".join(map(str, e.path)) or "(корінь)", "->", e.message[:160])
    else:
        print("ok  ", label)
print(f"\n{len(cases) - bad} із {len(cases)} справ валідні за схемою")
sys.exit(1 if bad else 0)
