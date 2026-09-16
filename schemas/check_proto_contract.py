#!/usr/bin/env python3
"""Перевірка відповідності proto-контракту модуля SEARCH нормативній JSON Schema.

Нормативним машинним контрактом дрон-частини відповіді `/search/routes` є
`schemas/post-drone.schema.json` (ТЗ, розділ A.8.4.2). Файли
`proto/transatlas/search/v1/*.proto` є типізованим поданням того самого
контракту для gRPC. Два описи однієї вимоги розходяться при першій же правці,
тому цей прогін звіряє їх машинно і падає при будь-якій розбіжності.

Що перевіряється
----------------
  P1  Перерахування: набір значень опції `wire` кожного enum дорівнює
      відповідному перерахуванню JSON Schema (без зайвих і без пропущених).
  P2  Патерни рядків: route_id, variant_of, order_pinned_below,
      normalization_base — побайтово ті самі регулярні вирази.
  P3  Кардинальність: legs 1..4, transships 0..3, gate 1..6,
      drone_diagnostics.items minItems = 1.
  P4  Покриття полів: кожна властивість JSON Schema має поле в proto.
  P5  Цілісність CEL-правила воріт: коди причин, які в схемі зобов'язані
      супроводжуватися номером воріт, у proto займають рівно той діапазон
      номерів, який перевіряє вираз `reason >= 1 && reason <= 8`.
      Перенумерація enum без правки виразу мовчки зламала б правило.
  P6  Тристан погоди: `weather.ok` типу boolean|null подано enum із рівно
      трьома змістовними значеннями.

Запуск
------
    python schemas/check_proto_contract.py
    python schemas/check_proto_contract.py --proto-dir proto --schema schemas/post-drone.schema.json

Код виходу 0 — контракти узгоджені; 1 — знайдено розбіжність; 2 — прогін не
вдалося виконати (немає компілятора або файлів).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent

# Оголошення `buf/validate/validate.proto`. Шлях можна перевизначити змінною
# оточення PROTOVALIDATE_DIR або аргументом --validate-dir; у CI він
# завантажується кроком `Fetch protovalidate`.
VALIDATE_PROTO = "buf/validate/validate.proto"

FAILURES: list[str] = []
CHECKS = 0


def fail(rule: str, message: str) -> None:
    FAILURES.append(f"[{rule}] {message}")


def check(rule: str, condition: bool, message: str) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        fail(rule, message)


def die(message: str) -> None:
    print(f"ПРОГІН НЕ ВИКОНАНО: {message}", file=sys.stderr)
    raise SystemExit(2)


# ---------------------------------------------------------------------------
# Компіляція proto і завантаження дескрипторів
# ---------------------------------------------------------------------------


def wellknown_include() -> str | None:
    try:
        import grpc_tools  # noqa: PLC0415
    except ImportError:
        return None
    return str(pathlib.Path(grpc_tools.__file__).parent / "_proto")


def compile_protos(proto_dir: pathlib.Path, validate_dir: pathlib.Path, out: pathlib.Path):
    """Скомпілювати proto в python-модулі й повернути імпортовані pb2."""
    sources = sorted(str(p.relative_to(proto_dir)) for p in proto_dir.rglob("*.proto"))
    if not sources:
        die(f"у {proto_dir} немає .proto файлів")

    includes = ["-I", str(proto_dir), "-I", str(validate_dir)]
    wk = wellknown_include()
    if wk:
        includes += ["-I", wk]

    args = [*includes, f"--python_out={out}", VALIDATE_PROTO, *sources]

    try:
        from grpc_tools import protoc  # noqa: PLC0415

        code = protoc.main(["protoc", *args])
    except ImportError:
        exe = shutil.which("protoc")
        if not exe:
            die("немає ні grpcio-tools, ні protoc — встановіть `pip install grpcio-tools`")
        code = subprocess.run([exe, *args], check=False).returncode

    if code != 0:
        die(f"protoc завершився з кодом {code}")

    sys.path.insert(0, str(out))
    try:
        from transatlas.search.v1 import common_pb2, lots_pb2, routes_pb2  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover
        die(f"не вдалося імпортувати згенеровані модулі: {exc}")
    return common_pb2, lots_pb2, routes_pb2


def load_validate_pb2():
    from buf.validate import validate_pb2  # noqa: PLC0415

    return validate_pb2


# ---------------------------------------------------------------------------
# Доступ до опцій
# ---------------------------------------------------------------------------


def wire_map(enum_desc, common_pb2) -> dict[str, str]:
    """{wire-значення: ім'я enum-значення} для всіх значень з опцією `wire`."""
    out: dict[str, str] = {}
    for value in enum_desc.values:
        opts = value.GetOptions()
        if not opts.Extensions[common_pb2.wire]:
            continue
        w = opts.Extensions[common_pb2.wire]
        if w in out:
            fail("P1", f"{enum_desc.full_name}: значення wire={w!r} дублюється")
        out[w] = value.name
    return out


def wire_numbers(enum_desc, common_pb2) -> dict[str, int]:
    return {
        value.GetOptions().Extensions[common_pb2.wire]: value.number
        for value in enum_desc.values
        if value.GetOptions().Extensions[common_pb2.wire]
    }


def field_rules(msg_desc, field_name: str, validate_pb2):
    field = msg_desc.fields_by_name.get(field_name)
    if field is None:
        return None
    return field.GetOptions().Extensions[validate_pb2.field]


# ---------------------------------------------------------------------------
# P1. Перерахування
# ---------------------------------------------------------------------------


def check_enums(schema: dict, common_pb2, lots_pb2, routes_pb2) -> None:
    defs = schema["$defs"]

    cases = [
        (
            "DroneReason",
            routes_pb2.DESCRIPTOR.enum_types_by_name["DroneReason"],
            set(defs["reason"]["enum"]),
        ),
        (
            "RouteWarning",
            routes_pb2.DESCRIPTOR.enum_types_by_name["RouteWarning"],
            set(defs["warning"]["enum"]),
        ),
        (
            "RouteOrigin",
            routes_pb2.DESCRIPTOR.enum_types_by_name["RouteOrigin"],
            set(defs["route"]["properties"]["origin"]["enum"]),
        ),
        (
            "DroneSkipped",
            routes_pb2.DESCRIPTOR.enum_types_by_name["DroneSkipped"],
            set(schema["properties"]["drone_skipped"]["enum"]),
        ),
        (
            "PointKind",
            common_pb2.DESCRIPTOR.enum_types_by_name["PointKind"],
            set(defs["point"]["oneOf"][1]["properties"]["kind"]["enum"]),
        ),
    ]

    for name, enum_desc, expected in cases:
        actual = set(wire_map(enum_desc, common_pb2))
        check(
            "P1",
            actual == expected,
            f"{name}: набір wire-значень не дорівнює перерахуванню схеми; "
            f"лишні={sorted(actual - expected)} відсутні={sorted(expected - actual)}",
        )

    # Види транспорту плеча: у схемі лише A/T/M/F/D. X (мультимодальний) —
    # розділ біржі, а не вид плеча, і в перерахуванні плеча його бути не може.
    mode_wires = set(wire_map(common_pb2.DESCRIPTOR.enum_types_by_name["TransportMode"], common_pb2))
    leg_modes = set(defs["leg"]["properties"]["mode"]["enum"])
    check(
        "P1",
        mode_wires - {"X"} == leg_modes,
        f"TransportMode: види плеча не збігаються зі схемою; "
        f"лишні={sorted(mode_wires - {'X'} - leg_modes)} відсутні={sorted(leg_modes - mode_wires)}",
    )
    check("P1", "X" not in leg_modes, "схема $defs.leg.mode не має містити X")

    # drone_cta.missing_leg.mode: у схемі лише A і D. У proto це обмеження
    # виражене списком `in`, і його треба звіряти саме зі схемою.
    validate_pb2 = load_validate_pb2()
    missing_leg = routes_pb2.DESCRIPTOR.message_types_by_name["DroneCta"].nested_types_by_name[
        "MissingLeg"
    ]
    rules = field_rules(missing_leg, "mode", validate_pb2)
    allowed_numbers = set(getattr(rules.enum, "in")) if rules else set()
    numbers = wire_numbers(common_pb2.DESCRIPTOR.enum_types_by_name["TransportMode"], common_pb2)
    allowed_wires = {w for w, n in numbers.items() if n in allowed_numbers}
    expected = set(defs["droneCta"]["properties"]["missing_leg"]["properties"]["mode"]["enum"])
    check(
        "P1",
        allowed_wires == expected,
        f"DroneCta.MissingLeg.mode: proto допускає {sorted(allowed_wires)}, схема — {sorted(expected)}",
    )

    # droneCta.action — у схемі const, у proto enum з одним змістовним значенням.
    action_wires = set(wire_map(routes_pb2.DESCRIPTOR.enum_types_by_name["DroneCtaAction"], common_pb2))
    check(
        "P1",
        action_wires == {defs["droneCta"]["properties"]["action"]["const"]},
        f"DroneCtaAction: {sorted(action_wires)} != const схеми",
    )

    # Внутрішні enum, яких немає в схемі POST_DRONE, мусять принаймні мати wire
    # на всіх змістовних значеннях — інакше JSON-подання буде неоднозначним.
    for module in (common_pb2, lots_pb2, routes_pb2):
        for enum_desc in module.DESCRIPTOR.enum_types_by_name.values():
            mapped = wire_map(enum_desc, common_pb2)
            meaningful = [v for v in enum_desc.values if v.number != 0]
            if enum_desc.name in {"WeatherStatus"}:
                continue  # тристан boolean|null, рядкового подання не має
            check(
                "P1",
                len(mapped) == len(meaningful),
                f"{enum_desc.full_name}: без опції wire лишилися "
                f"{[v.name for v in meaningful if not v.GetOptions().Extensions[common_pb2.wire]]}",
            )
            check(
                "P1",
                enum_desc.values[0].number == 0 and enum_desc.values[0].name.endswith("_UNSPECIFIED"),
                f"{enum_desc.full_name}: нульове значення мусить бути *_UNSPECIFIED",
            )


# ---------------------------------------------------------------------------
# P2. Патерни
# ---------------------------------------------------------------------------


def check_patterns(schema: dict, routes_pb2, validate_pb2) -> None:
    defs = schema["$defs"]
    route_id_pattern = defs["route_id"]["pattern"]
    parent_pattern = schema["properties"]["normalization_base"]["items"]["pattern"]

    route = routes_pb2.DESCRIPTOR.message_types_by_name["Route"]
    response = routes_pb2.DESCRIPTOR.message_types_by_name["SearchRoutesResponse"]

    expectations = [
        (route, "route_id", route_id_pattern),
        (route, "variant_of", parent_pattern),
        (route, "order_pinned_below", parent_pattern),
    ]
    for msg, field, expected in expectations:
        rules = field_rules(msg, field, validate_pb2)
        actual = rules.string.pattern if rules else None
        check(
            "P2",
            actual == expected,
            f"{msg.name}.{field}: патерн {actual!r} != {expected!r} зі схеми",
        )

    rules = field_rules(response, "normalization_base", validate_pb2)
    actual = rules.repeated.items.string.pattern if rules else None
    check(
        "P2",
        actual == expected_pattern(parent_pattern, actual),
        f"SearchRoutesResponse.normalization_base: патерн елемента {actual!r} != {parent_pattern!r}",
    )


def expected_pattern(expected: str, actual: str | None) -> str:
    """Допоміжник, щоб повідомлення про помилку показувало обидва значення."""
    return actual if actual == expected else expected


# ---------------------------------------------------------------------------
# P3. Кардинальність
# ---------------------------------------------------------------------------


def check_cardinality(schema: dict, routes_pb2, validate_pb2) -> None:
    defs = schema["$defs"]
    route = routes_pb2.DESCRIPTOR.message_types_by_name["Route"]
    diagnostics = routes_pb2.DESCRIPTOR.message_types_by_name["DroneDiagnostics"]
    item = routes_pb2.DESCRIPTOR.message_types_by_name["DiagnosticsItem"]

    legs = field_rules(route, "legs", validate_pb2)
    check(
        "P3",
        legs and legs.repeated.min_items == defs["route"]["properties"]["legs"]["minItems"],
        f"Route.legs: min_items != minItems={defs['route']['properties']['legs']['minItems']}",
    )
    check(
        "P3",
        legs and legs.repeated.max_items == defs["route"]["properties"]["legs"]["maxItems"],
        f"Route.legs: max_items != maxItems={defs['route']['properties']['legs']['maxItems']} (max_legs з дроном, A.6.7)",
    )

    transships = field_rules(route, "transships", validate_pb2)
    check(
        "P3",
        transships and transships.uint32.lte == defs["route"]["properties"]["transships"]["maximum"],
        "Route.transships: верхня межа не збігається зі схемою",
    )

    gate = field_rules(item, "gate", validate_pb2)
    check(
        "P3",
        gate and gate.uint32.gte == defs["gate"]["minimum"] and gate.uint32.lte == defs["gate"]["maximum"],
        f"DiagnosticsItem.gate: межі не збігаються з $defs.gate "
        f"({defs['gate']['minimum']}..{defs['gate']['maximum']})",
    )

    items = field_rules(diagnostics, "items", validate_pb2)
    check(
        "P3",
        items and items.repeated.min_items == schema["properties"]["drone_diagnostics"]["minItems"],
        "DroneDiagnostics.items: min_items != minItems зі схеми",
    )

    # Presence-обгортка існує саме для того, щоб «відсутнє» відрізнялося від
    # «порожнє» (A.8.4). Якщо поле стане repeated — різниця зникне.
    field = routes_pb2.DESCRIPTOR.message_types_by_name["SearchRoutesResponse"].fields_by_name[
        "drone_diagnostics"
    ]
    check(
        "P3",
        not field.is_repeated and field.has_presence,
        "SearchRoutesResponse.drone_diagnostics мусить мати presence: при diagnostics=false "
        "поле відсутнє, а не порожній масив",
    )
    for name in ("drone_skipped", "drone_cta"):
        f = routes_pb2.DESCRIPTOR.message_types_by_name["SearchRoutesResponse"].fields_by_name[name]
        check("P3", f.has_presence, f"SearchRoutesResponse.{name} мусить мати presence")


# ---------------------------------------------------------------------------
# P4. Покриття полів
# ---------------------------------------------------------------------------

# Поля схеми, яким у proto відповідає інша назва або інша структура.
FIELD_ALIASES = {
    ("Weather", "ok"): "status",
    ("Leg", "mode"): "mode",
}

# Поля proto, яких у схемі немає (схема має additionalProperties: true).
# Перелічені явно, щоб додавання поля «мимохідь» було видно в diff.
PROTO_ONLY = {
    "SearchRoutesResponse": {
        "state",
        "companies_on_direction",
        "possible_links",
        "base_currency_code",
        "post_drone_budget_ms",
    },
    "Route": {"scheme", "cost_known", "estimated_price", "total_time_h"},
    "Leg": {"depart", "arrive", "company", "cost_base", "cost_known", "transit_hours", "customs"},
    "Weather": {},
    "DiagnosticsItem": {},
    "DroneCta": {},
}


def check_coverage(schema: dict, routes_pb2) -> None:
    defs = schema["$defs"]
    pairs = [
        ("SearchRoutesResponse", schema["properties"]),
        ("Route", defs["route"]["properties"]),
        ("Weather", defs["weather"]["properties"]),
        ("DiagnosticsItem", defs["diagnosticsItem"]["properties"]),
        ("DroneCta", defs["droneCta"]["properties"]),
    ]

    for msg_name, properties in pairs:
        msg = routes_pb2.DESCRIPTOR.message_types_by_name[msg_name]
        fields = set(msg.fields_by_name)
        for prop in properties:
            target = FIELD_ALIASES.get((msg_name, prop), prop)
            check(
                "P4",
                target in fields,
                f"{msg_name}: властивість схеми {prop!r} не має поля в proto (очікувалося {target!r})",
            )
        extra = fields - set(properties) - set(PROTO_ONLY.get(msg_name, set()))
        extra -= {FIELD_ALIASES.get((msg_name, p), p) for p in properties}
        check(
            "P4",
            not extra,
            f"{msg_name}: у proto є незадеклароване поле {sorted(extra)} — додайте його в схему "
            f"або в PROTO_ONLY з обґрунтуванням",
        )

    # Дрон-плече в схемі описане окремим $defs.droneLeg, але лежить плоско на
    # об'єкті плеча, тому перевіряється проти того самого message Leg.
    leg = routes_pb2.DESCRIPTOR.message_types_by_name["Leg"]
    for prop in defs["droneLeg"]["properties"]:
        target = FIELD_ALIASES.get(("Leg", prop), prop)
        check(
            "P4",
            target in leg.fields_by_name,
            f"Leg: властивість $defs.droneLeg {prop!r} не має поля в proto",
        )


# ---------------------------------------------------------------------------
# P5. Цілісність CEL-правила воріт
# ---------------------------------------------------------------------------

# Коди причин, які в схемі зобов'язані супроводжуватися номером воріт
# (розділ A.8.4, `if/then` у $defs.diagnosticsItem).
GATE_RULE_ID = "diagnostics.gate_iff_gate_reason"


def gate_required_reasons(schema: dict) -> set[str]:
    for clause in schema["$defs"]["diagnosticsItem"]["allOf"]:
        cond = clause.get("if", {}).get("properties", {}).get("reason", {})
        if "enum" in cond and "gate" in clause.get("then", {}).get("required", []):
            return set(cond["enum"])
    return set()


def check_gate_rule(schema: dict, common_pb2, routes_pb2, validate_pb2) -> None:
    required = gate_required_reasons(schema)
    check("P5", bool(required), "у схемі не знайдено правило «код воріт вимагає gate»")
    if not required:
        return

    numbers = wire_numbers(routes_pb2.DESCRIPTOR.enum_types_by_name["DroneReason"], common_pb2)
    missing = required - set(numbers)
    check("P5", not missing, f"DroneReason не покриває коди схеми {sorted(missing)}")
    if missing:
        return

    gated = sorted(numbers[w] for w in required)
    check(
        "P5",
        gated == list(range(min(gated), max(gated) + 1)),
        f"номери gate-причин {gated} не є суцільним діапазоном — вираз "
        f"`reason >= X && reason <= Y` перестане бути точним",
    )

    item = routes_pb2.DESCRIPTOR.message_types_by_name["DiagnosticsItem"]
    rules = item.GetOptions().Extensions[validate_pb2.message]
    cel = {r.id: r.expression for r in rules.cel}
    check("P5", GATE_RULE_ID in cel, f"DiagnosticsItem: немає CEL-правила {GATE_RULE_ID!r}")
    if GATE_RULE_ID not in cel:
        return

    expression = cel[GATE_RULE_ID]
    lo, hi = min(gated), max(gated)
    check(
        "P5",
        f"reason >= {lo}" in expression and f"reason <= {hi}" in expression,
        f"CEL-правило {GATE_RULE_ID} перевіряє не той діапазон: очікувався {lo}..{hi} "
        f"за нумерацією DroneReason, у виразі — {expression!r}",
    )

    non_gated = {w for w in numbers if w not in required}
    check(
        "P5",
        all(numbers[w] < lo or numbers[w] > hi for w in non_gated),
        f"причини без воріт {sorted(non_gated)} потрапили в діапазон {lo}..{hi}",
    )


# ---------------------------------------------------------------------------
# P6. Тристан погоди
# ---------------------------------------------------------------------------


def check_weather_tristate(schema: dict, routes_pb2) -> None:
    ok_types = schema["$defs"]["weather"]["properties"]["ok"]["type"]
    check("P6", "null" in ok_types, "схема $defs.weather.ok мусить допускати null")

    enum_desc = routes_pb2.DESCRIPTOR.enum_types_by_name["WeatherStatus"]
    meaningful = [v.name for v in enum_desc.values if v.number != 0]
    check(
        "P6",
        len(meaningful) == 3,
        f"WeatherStatus мусить мати рівно три змістовні значення (true/false/null), а має {meaningful}",
    )
    check(
        "P6",
        "WEATHER_STATUS_UNAVAILABLE" in meaningful,
        "WeatherStatus мусить мати значення для недоступного джерела: "
        "підставляти вигадану погоду заборонено (НФВ A.11)",
    )

    wind = routes_pb2.DESCRIPTOR.message_types_by_name["Weather"].fields_by_name["wind_ms"]
    check(
        "P6",
        wind.has_presence,
        "Weather.wind_ms мусить мати presence: «0 м/с» і «немає даних» — різні стани",
    )


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proto-dir", default=str(REPO / "proto"))
    parser.add_argument("--schema", default=str(REPO / "schemas" / "post-drone.schema.json"))
    parser.add_argument(
        "--validate-dir",
        default=None,
        help="каталог з buf/validate/validate.proto (дефолт: $PROTOVALIDATE_DIR або ./third_party)",
    )
    args = parser.parse_args()

    proto_dir = pathlib.Path(args.proto_dir).resolve()
    schema_path = pathlib.Path(args.schema).resolve()
    if not proto_dir.is_dir():
        die(f"немає каталогу {proto_dir}")
    if not schema_path.is_file():
        die(f"немає схеми {schema_path}")

    import os

    validate_dir = pathlib.Path(
        args.validate_dir or os.environ.get("PROTOVALIDATE_DIR") or (REPO / "third_party")
    ).resolve()
    if not (validate_dir / VALIDATE_PROTO).is_file():
        die(
            f"немає {validate_dir / VALIDATE_PROTO}. Завантажте його або вкажіть "
            f"--validate-dir / PROTOVALIDATE_DIR"
        )

    schema = json.loads(schema_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory() as tmp:
        common_pb2, lots_pb2, routes_pb2 = compile_protos(
            proto_dir, validate_dir, pathlib.Path(tmp)
        )
        validate_pb2 = load_validate_pb2()

        check_enums(schema, common_pb2, lots_pb2, routes_pb2)
        check_patterns(schema, routes_pb2, validate_pb2)
        check_cardinality(schema, routes_pb2, validate_pb2)
        check_coverage(schema, routes_pb2)
        check_gate_rule(schema, common_pb2, routes_pb2, validate_pb2)
        check_weather_tristate(schema, routes_pb2)

    print(f"proto: {proto_dir}")
    print(f"схема: {schema_path}")
    print(f"перевірок виконано: {CHECKS}")

    if FAILURES:
        print(f"\nРОЗБІЖНОСТЕЙ: {len(FAILURES)}")
        for line in FAILURES:
            print(f"  {line}")
        return 1

    print("контракти узгоджені")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
