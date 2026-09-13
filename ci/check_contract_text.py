#!/usr/bin/env python3
"""Узгодженість тексту ТЗ зі схемою й proto-контрактом у двох місцях, де вона
вже одного разу розійшлася (розбіжності D-1 і D-2 з proto/README.md).

Групи сценаріїв:
  U1-U5 — одиниці ваги: тонни в запиті, кілограми в дрон-обмеженнях,
          перерахунок робить модуль, і жодне поле не є двозначним.
  N1-N5 — носій коду базової валюти: це base_currency_code, а не
          normalization_base, який лишається переліком route_id.

Перевіряються три носії одночасно: текст ТЗ, нормативна JSON Schema і
proto-контракт. Прогін із --self-test мутує копії й вимагає, щоб кожен
сценарій ловив свою поламку: перевірка, яку не можна зламати, нічого не
перевіряє.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ALGO = "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md"
SCHEMA = "schemas/post-drone.schema.json"
PROTO_DIR = "proto"

FAILS: list[str] = []
DONE = 0


def check(scenario: str, ok: bool, detail: str) -> None:
    global DONE
    DONE += 1
    if not ok:
        FAILS.append(f"{scenario}: {detail}")


def schema_validator(schema: dict):
    from jsonschema import Draft202012Validator

    return Draft202012Validator(schema)


def proto_descriptors(root: pathlib.Path):
    """Компілює контракт і повертає FileDescriptorSet."""
    import grpc_tools
    from google.protobuf import descriptor_pb2
    from grpc_tools import protoc

    well_known = pathlib.Path(grpc_tools.__file__).parent / "_proto"
    validate = os.environ.get("PROTOVALIDATE_DIR", str(root / "third_party"))
    out = pathlib.Path(tempfile.mkdtemp()) / "contract.desc"
    files = sorted(
        str(p.relative_to(root / PROTO_DIR))
        for p in (root / PROTO_DIR).rglob("*.proto")
    )
    argv = [
        "protoc",
        f"-I{root / PROTO_DIR}",
        f"-I{validate}",
        f"-I{well_known}",
        f"--descriptor_set_out={out}",
        "--include_imports",
        *files,
    ]
    if protoc.main(argv) != 0:
        raise SystemExit("proto-контракт не компілюється — див. прогін schemas/check_proto_contract.py")
    fds = descriptor_pb2.FileDescriptorSet()
    fds.ParseFromString(out.read_bytes())
    return fds


def iter_fields(fds):
    """Пари (повне імʼя повідомлення, FieldDescriptorProto) по всьому контракту."""
    def walk(prefix, msgs):
        for m in msgs:
            name = f"{prefix}.{m.name}"
            for f in m.field:
                yield name, f
            yield from walk(name, m.nested_type)

    for f in fds.file:
        if f.package.startswith("transatlas."):
            yield from walk(f.package, f.message_type)


# --------------------------------------------------------------------------
# U1-U5: одиниці ваги
# --------------------------------------------------------------------------

def check_units(root: pathlib.Path, fds) -> None:
    text = (root / ALGO).read_text(encoding="utf-8")
    lines = text.splitlines()

    # U1. Кожен рядок, де вага запиту стоїть поруч із дрон-лімітом у кг,
    # зобовʼязаний нести коефіцієнт 1000. Саме відсутність цього множника й була
    # розбіжністю D-2: «weight ≤ max_payload_kg» порівнювало тонни з кілограмами.
    bad = [
        i + 1
        for i, ln in enumerate(lines)
        if "max_payload_kg" in ln
        and re.search(r"weight(_t)?\b|вага|Вага", ln)
        and "1000" not in ln
    ]
    check("U1", not bad, f"порівняння ваги з max_payload_kg без перерахунку в рядках {bad}")

    # U2. Поле weight_t не має права бути двозначним: рядок таблиці A.3.2
    # описує тонни й не пропонує кілограмів як альтернативу.
    row = next((ln for ln in lines if "| `weight_t` |" in ln), None)
    check("U2", row is not None, "рядок `weight_t` у таблиці A.3.2 не знайдено")
    if row:
        check("U2", "тонн" in row.lower(), f"одиницю не названо тоннами: {row.strip()}")
        check(
            "U2",
            not re.search(r"\bкг\b|кілограм", row, re.IGNORECASE),
            f"рядок досі допускає кілограми для weight_t: {row.strip()}",
        )

    # U3. Псевдокод POST_DRONE (A.6.8) містить перерахунок явно, бо саме він
    # є нормативним викладом воріт 4.
    m = re.search(r"POST_DRONE\(route\):(.*?)```", text, re.S)
    check("U3", m is not None, "псевдокод POST_DRONE не знайдено")
    if m:
        check(
            "U3",
            re.search(r"weight_t\s*\*\s*1000\s*>\s*max_payload_kg", m.group(1)) is not None,
            "у псевдокоді воріт 4 немає перерахунку weight_t * 1000 > max_payload_kg",
        )

    # U4. Жодне числове поле маси в proto не є безсуфіксним: одиниця читається
    # з імені. Інакше двозначність, знята в тексті, повернулася б у контракт.
    numeric = {1, 2, 3, 4, 5, 6, 7, 13, 15, 16, 17, 18}  # double..sint64
    offenders = [
        f"{msg}.{f.name}"
        for msg, f in iter_fields(fds)
        if re.search(r"weight|payload|масa|mass", f.name)
        and f.type in numeric
        and not f.name.endswith(("_t", "_kg"))
    ]
    check("U4", not offenders, f"поля маси без суфікса одиниці: {offenders}")

    # U5. Обидві одиниці справді присутні в контракті під своїми іменами:
    # тонни в запиті пошуку, кілограми в дрон-плечі.
    names = {f"{msg}.{f.name}" for msg, f in iter_fields(fds)}
    check(
        "U5",
        "transatlas.search.v1.SearchRoutesRequest.weight_t" in names,
        "у SearchRoutesRequest немає weight_t",
    )
    check(
        "U5",
        "transatlas.search.v1.Leg.payload_kg" in names,
        "у Leg немає payload_kg",
    )


# --------------------------------------------------------------------------
# N1-N5: носій коду базової валюти
# --------------------------------------------------------------------------

def check_currency_carrier(root: pathlib.Path, fds) -> None:
    text = (root / ALGO).read_text(encoding="utf-8")
    lines = text.splitlines()
    schema = json.loads((root / SCHEMA).read_text(encoding="utf-8"))
    props = schema.get("properties", {})

    # N1. Схема — норматив — знає поле base_currency_code як код валюти.
    bcc = props.get("base_currency_code")
    check("N1", isinstance(bcc, dict), "у схемі немає base_currency_code")
    if isinstance(bcc, dict):
        check("N1", bcc.get("type") == "string", f"base_currency_code не рядок: {bcc.get('type')}")
        check("N1", bcc.get("pattern") == "^[A-Z]{3,4}$", f"несподіваний шаблон: {bcc.get('pattern')}")

    # N2. normalization_base лишається переліком route_id, і код валюти
    # відхиляється нею як значення невірного формату. Це і є машинна межа
    # між двома полями: припущення розбіжності D-1 схема не приймає.
    v = schema_validator(schema)
    check(
        "N2",
        not v.is_valid({"routes": [], "normalization_base": ["EUR"]}),
        "схема приймає код валюти в normalization_base",
    )
    check(
        "N2",
        v.is_valid({"routes": [], "normalization_base": ["rt_1"], "base_currency_code": "EUR"}),
        "схема відхиляє коректну пару normalization_base/base_currency_code",
    )
    check(
        "N2",
        not v.is_valid({"routes": [], "base_currency_code": "eur"}),
        "схема приймає код валюти в нижньому регістрі",
    )

    # N3. Той самий розподіл ролей у proto: рядок проти повторюваного рядка.
    fields = {f"{msg}.{f.name}": f for msg, f in iter_fields(fds)}
    LABEL_REPEATED, TYPE_STRING = 3, 9
    resp = "transatlas.search.v1.SearchRoutesResponse"
    for name, repeated in ((f"{resp}.base_currency_code", False), (f"{resp}.normalization_base", True)):
        f = fields.get(name)
        check("N3", f is not None, f"у proto немає {name}")
        if f is not None:
            check("N3", f.type == TYPE_STRING, f"{name}: тип не string")
            check(
                "N3",
                (f.label == LABEL_REPEATED) == repeated,
                f"{name}: кардинальність не та, що в схемі",
            )

    # N4. Текст ТЗ більше не призначає normalization_base носієм коду валюти.
    # Будь-який рядок, що говорить про код валюти, або називає правильне поле,
    # або взагалі не згадує normalization_base.
    bad = [
        i + 1
        for i, ln in enumerate(lines)
        if re.search(r"код(?:у|ом)?\s+валют", ln)
        and "normalization_base" in ln
        and "base_currency_code" not in ln
    ]
    check("N4", not bad, f"текст ТЗ знову вішає код валюти на normalization_base: рядки {bad}")

    # N5. Правильне поле в тексті назване, а не лише в схемі: інакше
    # розробник, який читає ТЗ, знову не знайде носія валюти.
    check("N5", "base_currency_code" in text, "текст ТЗ не згадує base_currency_code")
    check(
        "N5",
        any("base_currency_code" in ln and "total_cost_eur" in ln for ln in lines),
        "у тексті немає звʼязку base_currency_code з історичною назвою total_cost_eur",
    )


def run(root: pathlib.Path) -> int:
    fds = proto_descriptors(root)
    check_units(root, fds)
    check_currency_carrier(root, fds)
    if FAILS:
        print(f"перевірок виконано: {DONE}, провалів: {len(FAILS)}")
        for f in FAILS:
            print(f"  {f}")
        return 1
    print(f"перевірок виконано: {DONE}")
    print("текст ТЗ узгоджений зі схемою й proto-контрактом")
    return 0


# --------------------------------------------------------------------------
# Мутації: кожен сценарій має ловити свою поламку
# --------------------------------------------------------------------------

MUTATIONS = [
    ("U1", ALGO, "`weight_t × 1000 ≤ max_payload_kg` (вага запиту", "`weight ≤ max_payload_kg` (вага запиту"),
    ("U2", ALGO, "Вага вантажу, **тонни** — одна одиниця для всіх розділів, включно з дронами",
     "Вага, т (для дронів — кг)"),
    ("U3", ALGO, "if V.weight_t * 1000 > max_payload_kg: return None",
     "if V.weight > max_payload_kg: return None"),
    ("U4", "proto/transatlas/search/v1/routes.proto",
     "optional double payload_kg = 21", "optional double payload = 21"),
    ("U5", "proto/transatlas/search/v1/routes.proto",
     "double weight_t = 6", "double cargo_weight = 6"),
    ("N1", SCHEMA, '"base_currency_code": {', '"currency": {'),
    ("N2", SCHEMA, '"pattern": "^rt_[A-Za-z0-9]+$"', '"pattern": "^[A-Za-z0-9_]+$"'),
    ("N3", "proto/transatlas/search/v1/routes.proto",
     "string base_currency_code = 12", "repeated string base_currency_code = 12"),
    ("N4", ALGO, "фактичний код валюти передається окремим полем відповіді `base_currency_code` (розділ A.8.4.2)",
     "фактичний код валюти передається полем `normalization_base` (розділ A.8.4)"),
    ("N5", ALGO, "окремим полем відповіді `base_currency_code` (розділ A.8.4.2)",
     "окремим полем відповіді (розділ A.8.4.2)"),
]


def self_test(root: pathlib.Path) -> int:
    detected = 0
    for scenario, rel, old, new in MUTATIONS:
        tmp = pathlib.Path(tempfile.mkdtemp())
        work = tmp / "work"
        shutil.copytree(root, work, symlinks=True,
                        ignore=shutil.ignore_patterns(".git", ".pplx", "__pycache__"))
        target = work / rel
        src = target.read_text(encoding="utf-8")
        if old not in src:
            print(f"  {scenario}: МУТАЦІЮ НЕ ЗАСТОСОВАНО (фрагмент відсутній у {rel})")
            shutil.rmtree(tmp, ignore_errors=True)
            continue
        target.write_text(src.replace(old, new, 1), encoding="utf-8")
        r = subprocess.run([sys.executable, str(work / "ci" / "check_contract_text.py")],
                           cwd=work, capture_output=True, text=True)
        caught = r.returncode != 0 and (f"{scenario}:" in r.stdout or "не компілюється" in r.stdout + r.stderr)
        print(f"  {scenario}: {'виявлено' if caught else 'НЕ ВИЯВЛЕНО'} ({rel})")
        detected += bool(caught)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nмутацій: {len(MUTATIONS)}, виявлено: {detected}")
    if detected != len(MUTATIONS):
        print("мутаційний прогін провалено")
        return 1
    print("мутаційний прогін пройдено")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=None, help="корінь репозиторію (типово — каталог вище ci/)")
    ap.add_argument("--self-test", action="store_true", help="мутаційний прогін самих перевірок")
    a = ap.parse_args()
    root = pathlib.Path(a.root).resolve() if a.root else pathlib.Path(__file__).resolve().parent.parent
    if a.self_test:
        return self_test(root)
    return run(root)


if __name__ == "__main__":
    sys.exit(main())
