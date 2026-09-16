#!/usr/bin/env python3
"""Сумісність proto-контракту модуля SEARCH із базовою гілкою (ТЗ, розділ A.13.6).

Пакет `transatlas.search.v1` — публічний контракт: у ньому працюють клієнт
біржі, партнерські інтеграції та згенеровані SDK. Несумісна правка не ламає
компіляцію нашого репозиторію — вона ламає вже задеплоєних клієнтів у рантаймі,
і виявляється як «дивні дані» через тижні. Тому вона мусить блокувати злиття.

Перевіряється те, що ламає вже випущених клієнтів:
  B1  зникло повідомлення або перерахування;
  B2  зникло поле (номер вийшов з обігу без `reserved`);
  B3  у номера поля змінилося імʼя — старі й нові клієнти розійдуться в JSON;
  B4  у номера поля змінився тип або кардинальність;
  B5  зникло значення перерахування або змінився його номер;
  B6  змінилося значення опції `wire` — тобто рядок у JSON-поданні;
  B7  зник метод сервісу, змінився його тип потоку або типи запиту/відповіді.

Додавання нових полів, значень перерахувань і методів сумісне й дозволене.
Свідома несумісна зміна робиться новою версією пакета (`v2`), а не правкою
`v1` — тоді ця перевірка на `v1` знову зелена.

Запуск
------
    python ci/proto_breaking.py --base origin/main

Код виходу 0 — сумісно (або базу порівняння недоступно й прогін пропущено);
1 — знайдено несумісну зміну; 2 — прогін не вдалося виконати.
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
PROTO_GLOB = "transatlas/search/v1/*.proto"
WIRE_FIELD = 50001  # розширення EnumValueOptions, оголошене в common.proto


def die(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def well_known_dir() -> str:
    import grpc_tools
    return str(pathlib.Path(grpc_tools.__file__).parent / "_proto")


def build_descriptor(proto_dir: pathlib.Path, validate_dir: pathlib.Path, out: pathlib.Path) -> None:
    files = sorted(str(p.relative_to(proto_dir)) for p in proto_dir.glob(PROTO_GLOB))
    if not files:
        die(f"у {proto_dir} немає файлів {PROTO_GLOB}")
    cmd = [sys.executable, "-m", "grpc_tools.protoc",
           "-I", str(proto_dir), "-I", str(validate_dir), "-I", well_known_dir(),
           f"--descriptor_set_out={out}", "--include_imports", *files]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        die(f"protoc завершився з кодом {proc.returncode}:\n{proc.stderr.strip()}")


def load(desc_path: pathlib.Path):
    from google.protobuf import descriptor_pb2
    fds = descriptor_pb2.FileDescriptorSet()
    fds.ParseFromString(desc_path.read_bytes())
    return fds


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def wire_of(value) -> str | None:
    """Значення опції `wire` як рядок.

    Розширення оголошене в самому контракті, тому пул дескрипторів цього
    процесу його не знає й тримає як невідоме поле. Реалізація upb не дає
    доступу до невідомих полів (`NotImplementedError`), тому читаємо байти
    `EnumValueOptions` напряму. Це не залежить ні від генерації Python-модулів,
    ні від того, яка реалізація protobuf активна.
    """
    buf = value.options.SerializeToString()
    pos = 0
    while pos < len(buf):
        tag, pos = _varint(buf, pos)
        field_number, wire_type = tag >> 3, tag & 7
        if wire_type == 0:
            val, pos = _varint(buf, pos)
            if field_number == WIRE_FIELD:
                return str(val)
        elif wire_type == 2:
            length, pos = _varint(buf, pos)
            payload, pos = buf[pos:pos + length], pos + length
            if field_number == WIRE_FIELD:
                return payload.decode("utf-8")
        elif wire_type == 5:
            pos += 4
        elif wire_type == 1:
            pos += 8
        else:
            return None  # групи в контракті не використовуються
    return None


def index(fds) -> dict:
    """Пласке подання контракту: {повна назва -> опис} для порівняння."""
    messages: dict[str, dict[int, tuple[str, int, int, str]]] = {}
    enums: dict[str, dict[str, tuple[int, str | None]]] = {}
    services: dict[str, dict[str, tuple[str, str, bool, bool]]] = {}

    def walk_message(pkg: str, msg) -> None:
        full = f"{pkg}.{msg.name}"
        messages[full] = {
            f.number: (f.name, f.type, f.label, f.type_name) for f in msg.field
        }
        for nested in msg.nested_type:
            if not nested.options.map_entry:
                walk_message(full, nested)
        for en in msg.enum_type:
            walk_enum(full, en)

    def walk_enum(pkg: str, en) -> None:
        enums[f"{pkg}.{en.name}"] = {v.name: (v.number, wire_of(v)) for v in en.value}

    for f in fds.file:
        if not f.name.startswith("transatlas/search/v1/"):
            continue
        pkg = f.package
        for msg in f.message_type:
            walk_message(pkg, msg)
        for en in f.enum_type:
            walk_enum(pkg, en)
        for svc in f.service:
            services[f"{pkg}.{svc.name}"] = {
                m.name: (m.input_type, m.output_type, m.client_streaming, m.server_streaming)
                for m in svc.method
            }
    return {"messages": messages, "enums": enums, "services": services}


TYPE_NAMES = {1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32", 8: "bool",
              9: "string", 11: "message", 12: "bytes", 13: "uint32", 14: "enum"}
LABELS = {1: "optional", 2: "required", 3: "repeated"}


def compare(old: dict, new: dict) -> list[str]:
    bad: list[str] = []

    for name, fields in old["messages"].items():
        if name not in new["messages"]:
            bad.append(f"B1 зникло повідомлення {name}")
            continue
        cur = new["messages"][name]
        for num, (fname, ftype, flabel, ftname) in fields.items():
            if num not in cur:
                bad.append(f"B2 {name}: зникло поле {fname} (номер {num})")
                continue
            nname, ntype, nlabel, ntname = cur[num]
            if nname != fname:
                bad.append(f"B3 {name}: номер {num} перейменовано {fname} -> {nname}")
            if ntype != ftype or ntname != ftname:
                was = ftname or TYPE_NAMES.get(ftype, ftype)
                now = ntname or TYPE_NAMES.get(ntype, ntype)
                bad.append(f"B4 {name}.{fname}: змінився тип {was} -> {now}")
            if nlabel != flabel:
                bad.append(f"B4 {name}.{fname}: змінилася кардинальність "
                           f"{LABELS.get(flabel, flabel)} -> {LABELS.get(nlabel, nlabel)}")

    for name, values in old["enums"].items():
        if name not in new["enums"]:
            bad.append(f"B1 зникло перерахування {name}")
            continue
        cur = new["enums"][name]
        for vname, (vnum, vwire) in values.items():
            if vname not in cur:
                bad.append(f"B5 {name}: зникло значення {vname}")
                continue
            nnum, nwire = cur[vname]
            if nnum != vnum:
                bad.append(f"B5 {name}.{vname}: змінився номер {vnum} -> {nnum}")
            if nwire != vwire:
                bad.append(f"B6 {name}.{vname}: змінилося JSON-значення wire "
                           f"{vwire!r} -> {nwire!r}")

    for name, methods in old["services"].items():
        if name not in new["services"]:
            bad.append(f"B7 зник сервіс {name}")
            continue
        cur = new["services"][name]
        for mname, sig in methods.items():
            if mname not in cur:
                bad.append(f"B7 {name}: зник метод {mname}")
                continue
            if cur[mname] != sig:
                bad.append(f"B7 {name}.{mname}: змінилася сигнатура або тип потоку "
                           f"{sig} -> {cur[mname]}")
    return bad


def export_base(base: str, dest: pathlib.Path) -> bool:
    """Викласти proto базової гілки в dest. False — бази немає (перший PR)."""
    ls = subprocess.run(["git", "-C", str(REPO), "ls-tree", "-r", "--name-only", base, "proto/"],
                        capture_output=True, text=True)
    if ls.returncode != 0:
        return False
    paths = [p for p in ls.stdout.split() if p.endswith(".proto")]
    if not paths:
        return False
    for rel in paths:
        show = subprocess.run(["git", "-C", str(REPO), "show", f"{base}:{rel}"],
                              capture_output=True, text=True)
        if show.returncode != 0:
            return False
        out = dest / pathlib.Path(rel).relative_to("proto")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(show.stdout, encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/main", help="git-ref базової гілки")
    ap.add_argument("--proto-dir", default=str(REPO / "proto"))
    ap.add_argument("--validate-dir", default=str(REPO / "third_party"))
    args = ap.parse_args()

    if shutil.which("git") is None:
        die("немає git")
    try:
        import grpc_tools  # noqa: F401
        from google.protobuf import descriptor_pb2  # noqa: F401
    except ImportError as exc:
        die(f"немає залежності: {exc}")

    validate_dir = pathlib.Path(args.validate_dir)
    if not (validate_dir / "buf" / "validate" / "validate.proto").exists():
        die(f"немає {validate_dir}/buf/validate/validate.proto")

    with tempfile.TemporaryDirectory() as tmp:
        tmpd = pathlib.Path(tmp)
        base_proto = tmpd / "base"
        base_proto.mkdir()
        if not export_base(args.base, base_proto):
            print(f"у {args.base} немає proto-контракту — порівнювати нема з чим, "
                  f"перевірка сумісності пропускається")
            return 0

        build_descriptor(base_proto, validate_dir, tmpd / "base.desc")
        build_descriptor(pathlib.Path(args.proto_dir), validate_dir, tmpd / "head.desc")
        old = index(load(tmpd / "base.desc"))
        new = index(load(tmpd / "head.desc"))

    bad = compare(old, new)
    counted = (len(old["messages"]), len(old["enums"]), len(old["services"]))
    print(f"порівняно з {args.base}: повідомлень {counted[0]}, перерахувань {counted[1]}, "
          f"сервісів {counted[2]}")
    if bad:
        print("\nнесумісні зміни:")
        for line in bad:
            print(f"  {line}")
        print(f"\nвсього: {len(bad)}. Несумісна зміна робиться новою версією пакета "
              f"(transatlas.search.v2), а не правкою v1 — розділ A.13.6 ТЗ.", file=sys.stderr)
        return 1
    print("сумісно з базовою гілкою")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
