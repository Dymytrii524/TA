#!/usr/bin/env python3
"""Мутаційний прогін proto-контракту модуля SEARCH (ТЗ, розділ A.13.4).

Перевірка `schemas/check_proto_contract.py` цінна лише тим, що падає. Прогін,
який вивів «контракти узгоджені» на будь-якому вході, нічого не гарантує:
достатньо помилки в самій перевірці, і розбіжність proto з нормативною
JSON Schema поїде в реліз мовчки.

Тому кожна перевірка P1-P6 має тут мутацію — навмисно зламану копію
контракту. Мутація, якої перевірка не помітила, — це дефект перевірки, і цей
прогін падає саме на ньому, а не на продакшені партнерського клієнта.

Оригінальні файли не змінюються: працюємо в тимчасовій копії дерева.

Код виходу 0 — усі мутації виявлено; 1 — щось пропущено або еталон не
проходить; 2 — прогін не вдалося виконати.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
CHECKER = "schemas/check_proto_contract.py"

ROUTES = "proto/transatlas/search/v1/routes.proto"
COMMON = "proto/transatlas/search/v1/common.proto"

# (правило, назва, файл, що замінити, на що замінити).
# Кожна мутація змінює рівно один фрагмент і мусить дати код виходу 1.
MUTATIONS: list[tuple[str, str, str, str, str]] = [
    ("P1", "перейменувати wire-значення причини пропуску", ROUTES,
     '(wire) = "out_of_range"', '(wire) = "range_exceeded"'),
    ("P1", "прибрати опцію wire у виду транспорту", COMMON,
     'TRANSPORT_MODE_SEA = 4 [(wire) = "M"];', 'TRANSPORT_MODE_SEA = 4;'),
    ("P2", "звузити патерн route_id", ROUTES,
     '"^rt_[A-Za-z0-9]+(_d)?$"', '"^rt_[0-9]+(_d)?$"'),
    ("P3", "розширити ліміт плечей 4 -> 5", ROUTES,
     "max_items: 4", "max_items: 5"),
    ("P3", "змінити межі воріт 1..6 -> 0..6", ROUTES,
     "(buf.validate.field).uint32.gte = 1,\n    (buf.validate.field).uint32.lte = 6",
     "(buf.validate.field).uint32.gte = 0,\n    (buf.validate.field).uint32.lte = 6"),
    ("P3", "зробити drone_diagnostics repeated замість presence", ROUTES,
     "optional DroneDiagnostics drone_diagnostics = 10;",
     "repeated DroneDiagnostics drone_diagnostics = 10;"),
    ("P4", "додати незадеклароване поле в Route", ROUTES,
     "  repeated Leg legs = 14", "  string internal_debug_note = 99;\n\n  repeated Leg legs = 14"),
    ("P5", "вивести gate-причину за суцільний діапазон", ROUTES,
     'DRONE_REASON_NO_DRONE_LOT = 5 [(wire) = "no_drone_lot"];',
     'DRONE_REASON_NO_DRONE_LOT = 11 [(wire) = "no_drone_lot"];'),
    ("P5", "звузити діапазон у самому CEL-виразі 1..8 -> 1..7", ROUTES,
     '"(this.reason >= 1 && this.reason <= 8) ? has(this.gate) : !has(this.gate)"',
     '"(this.reason >= 1 && this.reason <= 7) ? has(this.gate) : !has(this.gate)"'),
    ("P5", "втратити CEL-правило воріт цілком", ROUTES,
     'id: "diagnostics.gate_iff_gate_reason"', 'id: "diagnostics.gate_note"'),
    ("P6", "прибрати стан «джерело недоступне» в погоді", ROUTES,
     "  WEATHER_STATUS_UNAVAILABLE = 3;\n", ""),
    ("P6", "прибрати presence у wind_ms", ROUTES,
     "optional double wind_ms = 2", "double wind_ms = 2"),
]


def run_checker(root: pathlib.Path) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(root / CHECKER),
         "--proto-dir", str(root / "proto"),
         "--schema", str(root / "schemas" / "post-drone.schema.json"),
         "--validate-dir", str(root / "third_party")],
        capture_output=True, text=True,
    )
    detail = next((ln.strip() for ln in proc.stdout.splitlines() if ln.strip().startswith("[")), "")
    if not detail:
        detail = (proc.stderr.strip().splitlines() or [""])[-1]
    return proc.returncode, detail


def main() -> int:
    src = REPO
    for rel in ("proto", "schemas", "third_party"):
        if not (src / rel).exists():
            print(f"немає каталогу {rel} — прогін неможливий", file=sys.stderr)
            return 2

    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp) / "repo"
        root.mkdir()
        for rel in ("proto", "schemas", "third_party"):
            shutil.copytree(src / rel, root / rel)
        gold = {p: p.read_text(encoding="utf-8") for p in root.rglob("*.proto")}

        code, detail = run_checker(root)
        if code != 0:
            print(f"еталонний контракт не проходить перевірку (код {code}): {detail}", file=sys.stderr)
            return 1
        print("еталон: перевірка проходить")

        missed: list[str] = []
        for rule, name, rel, old, new in MUTATIONS:
            for path, text in gold.items():
                path.write_text(text, encoding="utf-8")
            target = root / rel
            text = target.read_text(encoding="utf-8")
            if old not in text:
                print(f"ПРОПУЩЕНО {rule} {name}: цільовий фрагмент не знайдено — мутацію треба оновити")
                missed.append(f"{rule} {name}")
                continue
            target.write_text(text.replace(old, new, 1), encoding="utf-8")

            code, detail = run_checker(root)
            # Код 2 приймається: protoc відкинув мутацію ще на компіляції,
            # тобто злиття однаково заблоковано.
            if code in (1, 2):
                print(f"виявлено  {rule} {name}")
                if detail:
                    print(f"          {detail[:160]}")
            else:
                print(f"ПРОПУЩЕНО {rule} {name}: перевірка не впала")
                missed.append(f"{rule} {name}")

        for path, text in gold.items():
            path.write_text(text, encoding="utf-8")

        print(f"\nмутацій: {len(MUTATIONS)}, виявлено: {len(MUTATIONS) - len(missed)}")
        if missed:
            print("не виявлено: " + "; ".join(missed), file=sys.stderr)
            return 1
        print("мутаційний прогін пройдено")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
