#!/usr/bin/env python3
"""Прогін валютних і мовних сценаріїв (рамкове ТЗ, розділи 13.6 і 14.7).

Не потребує ні бази, ні застосунку: читає фікстури з i18n/, схему
schemas/i18n.schema.json і самі таблиці ТЗ, тому розбіжність між документом
і конфігурацією падає одразу. Мутаційне тестування доводить, що кожна
перевірка справді спрацьовує.

Сценарії C1-C9 і L1-L6 перевіряють склад MVP (4 мови, 9 валют).
Сценарії C10-C13 і L7-L12 перевіряють повний реєстр ТЗ v2 (24 мови +
резерв, 30+ валют за 9 рівнями) і його узгодженість із складом MVP.

Код виходу 0 — усі сценарії пройдені; 1 — є розбіжність.
"""
import copy
import json
import os
import re
import sys

from jsonschema import Draft202012Validator, FormatChecker

ROOT = os.environ.get("CONTRACT_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "ТЗ-рамкове-логістична-біржа.md")
SPEC_V2 = os.path.join(ROOT, "ТЗ-логістична-біржа-v2-мови-валюти.md")
LANGS = ["uk", "en", "pl", "de"]
RTL_LANGS = {"ar", "he", "fa", "ur"}
ICU_PLURAL_KEYWORDS = {"zero", "one", "two", "few", "many", "other"}

# Категорії множини (cardinal) за CLDR 47, Language Plural Rules — без власного трактування.
CLDR_PLURALS = {
    "uk": ["one", "few", "many", "other"], "en": ["one", "other"],
    "pl": ["one", "few", "many", "other"], "de": ["one", "other"],
    "ro": ["one", "few", "other"], "cs": ["one", "few", "many", "other"],
    "sk": ["one", "few", "many", "other"], "hu": ["one", "other"],
    "bg": ["one", "other"], "lt": ["one", "few", "many", "other"],
    "lv": ["zero", "one", "other"], "et": ["one", "other"],
    "sl": ["one", "two", "few", "other"], "hr": ["one", "few", "other"],
    "sr": ["one", "few", "other"], "fr": ["one", "many", "other"],
    "es": ["one", "many", "other"], "it": ["one", "many", "other"],
    "nl": ["one", "other"], "pt": ["one", "many", "other"],
    "tr": ["one", "other"], "el": ["one", "other"], "sv": ["one", "other"],
    "ar": ["zero", "one", "two", "few", "many", "other"], "zh": ["other"],
    "ka": ["one", "other"], "az": ["one", "other"], "kk": ["one", "other"],
    "uz": ["one", "other"], "hy": ["one", "other"], "da": ["one", "other"],
    "nb": ["one", "other"], "fi": ["one", "other"],
}

# Простори імен файлів перекладу, оголошені в ТЗ v2, п. 12.10.
SPEC_NAMESPACES = ["common", "exchange", "services", "admin", "emails", "legal", "glossary"]

schema = json.load(open(os.path.join(ROOT, "schemas", "i18n.schema.json"), encoding="utf-8"))


def load(rel):
    return json.load(open(os.path.join(ROOT, rel), encoding="utf-8"))


def validator(defname):
    sub = dict(schema)
    sub["$ref"] = f"#/$defs/{defname}"
    return Draft202012Validator(sub, format_checker=FormatChecker())


def errs(defname, doc):
    return list(validator(defname).iter_errors(doc))


FIX = {
    "currencies": load("i18n/currencies.json"),
    "locales": load("i18n/locales.json"),
    "glossary": load("i18n/glossary.json"),
    "deal_ok": load("i18n/deal-luts-hamburg.json"),
    "deal_stale": load("i18n/deal-stale-rate.json"),
    "routes": load("i18n/routes-display.json"),
    "messages": {l: load(f"i18n/messages/{l}.json") for l in LANGS},
    "lang_roadmap": load("i18n/language-roadmap.json"),
    "cur_roadmap": load("i18n/currency-roadmap.json"),
    "namespaces": load("i18n/namespaces.json"),
}
SPEC_TEXT = open(SPEC, encoding="utf-8").read()
SPEC_V2_TEXT = open(SPEC_V2, encoding="utf-8").read()

TAG_RE = re.compile(r"`([a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?)`")


def _section(text, header, stop="\n### "):
    a = text.index(header)
    try:
        b = text.index(stop, a + len(header))
    except ValueError:
        b = len(text)
    return text[a:b]


def spec_section(header):
    return _section(SPEC_TEXT, header)


def spec2_section(header):
    """Розділ ТЗ v2 — єдине джерело істини про повний реєстр мов і валют."""
    return _section(SPEC_V2_TEXT, header)


def spec2_subsection(section, header):
    return _section(section, header, stop="\n#### ")


def spec2_stage_tags(stage_header):
    """Теги локалей із таблиці одного етапу п. 12.2 ТЗ v2 (перший тег у колонці)."""
    sub = spec2_subsection(spec2_section("### 12.2."), stage_header)
    tags = []
    for line in sub.splitlines():
        m = re.match(r"^\|\s*\d+\s*\|([^|]*)\|([^|]*)\|", line)
        if not m:
            continue
        found = TAG_RE.findall(m.group(2))
        assert found, f"у рядку таблиці 12.2 немає тега локалі: {line!r}"
        tags.append(found[0])
    return tags


def spec2_reserve_tags():
    sub = spec2_subsection(spec2_section("### 12.2."), "#### Резерв")
    return TAG_RE.findall(sub)


def spec2_currency_levels():
    """Рівні валют із таблиці п. 12.4 ТЗ v2: {рівень: [коди]}."""
    out = {}
    for line in spec2_section("### 12.4.").splitlines():
        m = re.match(r"^\|\s*\*\*(\d)\.[^|]*\|([^|]*)\|", line)
        if m:
            out[int(m.group(1))] = re.findall(r"`([A-Z]{3,4})`", m.group(2))
    return out


def spec2_escrow_currencies():
    """Валюти Web3-ескроу із матриці п. 12.5 ТЗ v2."""
    for line in spec2_section("### 12.5.").splitlines():
        if "ескроу" in line.lower() and "|" in line:
            codes = re.findall(r"`([A-Z]{3,4})`", line)
            if codes:
                return codes
    raise AssertionError("у матриці 12.5 немає рядка про ескроу з кодами валют")


def icu_scan(text):
    """Мінімальний розбір ICU MessageFormat: баланс дужок і категорії plural/select."""
    depth = 0
    for ch in text:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            assert depth >= 0, f"закриваюча дужка без відкриваючої: {text!r}"
    assert depth == 0, f"незбалансовані дужки ICU: {text!r}"
    used = set()
    for m in re.finditer(r"\{\s*\w+\s*,\s*(plural|selectordinal|select)\s*,", text):
        body = text[m.end():]
        keys = re.findall(r"(?:^|[\s}])(=\d+|\w+)\s*\{", body)
        assert keys, f"блок {m.group(1)} без варіантів: {text!r}"
        if m.group(1) in ("plural", "selectordinal"):
            for k in keys:
                assert k.startswith("=") or k in ICU_PLURAL_KEYWORDS, (
                    f"невідома категорія множини {k!r} у {text!r}")
                if not k.startswith("="):
                    used.add(k)
            assert "other" in keys, f"блок {m.group(1)} без варіанта other: {text!r}"
    return used


def fmt_amount(value, loc, code):
    """Форматування суми за локаллю (розділ 13.3): формат залежить від локалі, не від валюти."""
    whole, frac = f"{value:.2f}".split(".")
    groups = []
    while len(whole) > 3:
        groups.insert(0, whole[-3:])
        whole = whole[:-3]
    groups.insert(0, whole)
    body = loc["group_sep"].join(groups) + loc["decimal_sep"] + frac
    return f"{body}\u00a0{code}" if loc["currency_position"] == "after" else f"{code}\u00a0{body}"


# --- сценарії ------------------------------------------------------------

def c1_currency_list_matches_spec(F):
    """C1. Перелік валют у конфігурації збігається з таблицею розділу 13.1 ТЗ."""
    table = spec_section("### 13.1.")
    in_spec = [m.group(1) for m in re.finditer(r"^\| ([A-Z]{3,4}) \|", table, re.M)]
    in_conf = [c["code"] for c in F["currencies"]["currencies"] if c.get("enabled", True)]
    missing = sorted(set(in_spec) - set(in_conf))
    extra = sorted(set(in_conf) - set(in_spec) - {"USDT"})
    assert not missing, f"валюти є в ТЗ, але не в конфігурації: {missing}"
    assert not extra, f"валюти є в конфігурації, але не в ТЗ: {extra}"
    assert len(in_spec) == 8, f"у таблиці 13.1 мусить бути 8 валют MVP, знайдено {len(in_spec)}"


def c2_single_base_currency(F):
    """C2. Базова валюта одна, вона ж — база нормалізації додатка A."""
    conf = F["currencies"]
    bases = [c["code"] for c in conf["currencies"] if "base" in c["roles"]]
    assert bases == [conf["base"]], f"базова валюта неузгоджена: base={conf['base']}, roles={bases}"
    annex = os.path.join(ROOT, "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md")
    text = open(annex, encoding="utf-8").read()
    assert "Базова валюта за замовчуванням — EUR" in text, "додаток A не оголошує ту саму базову валюту"
    assert conf["base"] == "EUR", "додаток A нормалізує в EUR — конфігурація мусить збігатися"


def c3_escrow_assets(F):
    """C3. Ескроу: USDC основний, USDT лише додатковий."""
    conf = F["currencies"]
    esc = [c["code"] for c in conf["currencies"] if "escrow" in c["roles"]]
    assert conf["escrow"]["primary"] == "USDC", "основним активом ескроу мусить бути USDC"
    assert "USDT" in conf["escrow"]["secondary"], "USDT мусить бути в переліку додаткових активів"
    assert set(esc) == {"USDC", "USDT"}, f"активами ескроу можуть бути лише USDC і USDT, знайдено {esc}"
    for code in esc:
        kind = next(c["kind"] for c in conf["currencies"] if c["code"] == code)
        assert kind == "stablecoin", f"{code} має бути stablecoin"


def c4_price_not_equal_payment(F):
    """C4. Валюта ціни, договору й платежу зберігаються окремо, платіж дорівнює ціні за зафіксованим курсом."""
    d = F["deal_ok"]
    assert d["price"]["currency"] != d["payment"]["currency"], "сценарій мусить мати різні валюти ціни й платежу"
    assert d["contract"]["currency"] == d["price"]["currency"], "валюта договору мусить бути окремим полем"
    expect = round(d["price"]["amount"] * d["fx"]["rate"], 2)
    assert abs(d["payment"]["amount"] - expect) <= 0.01, (
        f"платіж {d['payment']['amount']} не дорівнює ціні за курсом ({expect})")
    assert d["fx"]["pair"] == f"{d['price']['currency']}/{d['payment']['currency']}", "пара курсу не відповідає валютам угоди"


def c5_escrow_equals_payment_and_conditions(F):
    """C5. Сума ескроу дорівнює платежу, умови вивільнення непорожні, кошти не вивільнені."""
    d = F["deal_ok"]
    e = d["escrow"]
    assert e is not None, "сценарій мусить мати ескроу"
    assert e["currency"] == d["payment"]["currency"], "ескроу в іншій валюті, ніж платіж"
    assert abs(e["amount"] - d["payment"]["amount"]) <= 0.01, "сума ескроу не дорівнює сумі платежу"
    assert e["asset_role"] == "primary" and e["currency"] == "USDC", "основний сценарій — ескроу в USDC"
    assert {"gps_delivery_confirmed", "ecmr_uploaded"} <= set(e["release_conditions"]), (
        "базовий сценарій вивільнення — GPS-підтвердження плюс e-CMR")
    assert e["released"] is False, "до підтвердження доставки кошти не вивільняються"


def c6_conversion_log(F):
    """C6. Кожна конвертація має запис у журналі з курсом, джерелом і часом фіксації."""
    for key in ("deal_ok", "deal_stale"):
        d = F[key]
        log = d["conversion_log"]
        entities = {e["entity"] for e in log}
        if d["payment"]["currency"] != d["price"]["currency"]:
            assert "payment" in entities, f"{key}: конвертація платежу не записана в журнал"
        if d["escrow"]:
            assert "escrow" in entities, f"{key}: блокування ескроу не записане в журнал"
        if d["commission"]["currency"] != d["price"]["currency"]:
            assert "commission" in entities, f"{key}: конвертація комісії не записана в журнал"
        for e in log:
            assert e["rate"] == d["fx"]["rate"], f"{key}: курс у журналі не збігається з курсом угоди"
            assert e["source"] == d["fx"]["source"], f"{key}: джерело курсу в журналі не збігається"
            assert e["fixed_at"] == d["fx"]["fixed_at"], f"{key}: час фіксації в журналі не збігається"


def c7_stale_rate_notice(F):
    """C7. Застарілий курс дає позначку для користувача, а не помилку й не підставлений курс."""
    d = F["deal_stale"]
    assert d["fx"]["stale"] is True, "сценарій мусить мати застарілий курс"
    assert d["fx"].get("display_stale_notice") is True, "застарілий курс мусить супроводжуватись позначкою"
    assert d["fx"]["rate"] > 0, "курс не може бути нульовим або відсутнім"
    for l in LANGS:
        assert "fx.stale_notice" in F["messages"][l], f"{l}: немає повідомлення про застарілий курс"


def c8_locale_formatting(F):
    """C8. Формат суми залежить від локалі, а не від валюти: те саме значення, різне подання."""
    seen = {}
    for name, loc in F["locales"]["locales"].items():
        got = fmt_amount(2400, loc, "EUR")
        assert got == loc["sample_2400"], f"{name}: очікувалось {loc['sample_2400']!r}, отримано {got!r}"
        seen[name] = got
    assert len({v for v in seen.values()}) >= 2, "локалі не відрізняються форматуванням — модель локалізації фіктивна"
    for name, loc in F["locales"]["locales"].items():
        other = fmt_amount(2400, loc, "UAH")
        assert other.replace("UAH", "") == seen[name].replace("EUR", ""), (
            f"{name}: формат числа змінився разом із валютою")


def c9_order_independent_of_display_currency(F):
    """C9. Порядок видачі не залежить від валюти відображення (розділ A.7)."""
    r = F["routes"]
    known = [x for x in r["routes"] if x["cost_known"]]
    base_order = [x["route_id"] for x in sorted(known, key=lambda x: x["cost_base_eur"])]
    for code, rate in r["display_rates"].items():
        assert rate > 0, f"курс відображення {code} мусить бути додатним"
        order = [x["route_id"] for x in sorted(known, key=lambda x: x["cost_base_eur"] * rate)]
        assert order == base_order, f"порядок у валюті {code} відрізняється від базового: {order} != {base_order}"
    unknown = [x["route_id"] for x in r["routes"] if not x["cost_known"]]
    assert unknown, "сценарій мусить містити маршрут із невідомою вартістю"
    assert all(x not in base_order for x in unknown), "маршрут із cost_known=false не бере участі в сортуванні"


def l1_message_key_parity(F):
    """L1. Каталоги чотирьох мов MVP мають однаковий набір ключів."""
    ref = set(F["messages"]["uk"])
    for l in LANGS:
        keys = set(F["messages"][l])
        assert keys == ref, (
            f"{l}: різниця ключів — бракує {sorted(ref - keys)}, лишнє {sorted(keys - ref)}")
    for l in LANGS:
        for k, v in F["messages"][l].items():
            assert v.strip(), f"{l}: порожнє значення ключа {k}"


def l2_placeholder_parity(F):
    """L2. Підстановки в перекладах збігаються з оригіналом (жодна не втрачена й не додана)."""
    for k in F["messages"]["uk"]:
        ref = set(re.findall(r"\{(\w+)\}", F["messages"]["uk"][k]))
        for l in LANGS:
            got = set(re.findall(r"\{(\w+)\}", F["messages"][l][k]))
            assert got == ref, f"{l}, ключ {k}: підстановки {sorted(got)} != {sorted(ref)}"


def l3_glossary_terms_preserved(F):
    """L3. Терміни з глосарію не перекладаються варіативно (розділ 14.5)."""
    terms = [t["term"] for t in F["glossary"]["terms"] if t["do_not_translate"]]
    assert terms, "глосарій без термінів із забороною перекладу"
    covered = set()
    for k in F["messages"]["en"]:
        for term in terms:
            pat = re.compile(rf"(?<![\w-]){re.escape(term)}(?![\w])")
            if pat.search(F["messages"]["en"][k]):
                covered.add(term)
                for l in LANGS:
                    assert pat.search(F["messages"][l][k]), (
                        f"{l}, ключ {k}: термін {term} втрачено або перекладено")
    missing = sorted(set(terms) - covered)
    assert not missing, f"фікстури не покривають терміни глосарію: {missing}"


def l4_mvp_languages_match_spec(F):
    """L4. Склад мов MVP збігається з таблицею розділу 14.2 ТЗ і не містить російської."""
    table = spec_section("### 14.2.")
    names = {"Українська": "uk", "Англійська": "en", "Польська": "pl", "Німецька": "de"}
    found = {code for name, code in names.items() if f"| {name} |" in table}
    assert found == set(LANGS), f"у таблиці 14.2 бракує мов MVP: {sorted(set(LANGS) - found)}"
    assert "Російська" not in table and "російською" not in table.split("Успадковане")[0], (
        "російська мова не входить до складу MVP")
    langs_conf = {loc["language"] for loc in F["locales"]["locales"].values()}
    assert langs_conf == set(LANGS), f"локалі конфігурації {sorted(langs_conf)} != мови MVP {LANGS}"


def l5_machine_translation_marker(F):
    """L5. Машинний переклад завжди позначений і дає доступ до оригіналу."""
    for l in LANGS:
        v = F["messages"][l]["chat.machine_translation_notice"]
        assert v.strip(), f"{l}: немає позначки машинного перекладу"
        low = v.lower()
        assert any(w in low for w in ("машин", "machine", "maszyn", "maschinell")), (
            f"{l}: позначка не згадує машинний переклад: {v!r}")
        assert any(w in low for w in ("оригінал", "original", "oryginał")), (
            f"{l}: позначка не дає доступу до оригіналу: {v!r}")


def l6_original_language_field(F):
    """L6. Поле «оригінальна мова оголошення» присутнє в усіх мовних версіях інтерфейсу."""
    for l in LANGS:
        assert "lot.original_language" in F["messages"][l], f"{l}: немає поля оригінальної мови оголошення"
        assert "lot.currency" in F["messages"][l], f"{l}: немає поля валюти ставки"


# --- сценарії повного реєстру ТЗ v2, розділ 12 ----------------------------

def c10_currency_roadmap_matches_spec(F):
    """C10. Повний валютний реєстр збігається з таблицею девʼяти рівнів п. 12.4 ТЗ v2."""
    spec = spec2_currency_levels()
    assert sorted(spec) == list(range(1, 10)), f"у таблиці 12.4 мусить бути 9 рівнів, знайдено {sorted(spec)}"
    assert spec[9] == [], "рівень 9 (власний токен) не має закріплених кодів валют"
    conf = {}
    for c in F["cur_roadmap"]["currencies"]:
        assert c["code"] not in conf, f"валюта {c['code']} дублюється в реєстрі"
        conf[c["code"]] = c["level"]
    for level, codes in spec.items():
        for code in codes:
            assert code in conf, f"валюта {code} є в таблиці 12.4, але не в реєстрі"
            assert conf[code] == level, f"{code}: рівень у реєстрі {conf[code]} != рівня {level} у ТЗ"
    extra = sorted(set(conf) - {c for codes in spec.values() for c in codes})
    assert not extra, f"валюти є в реєстрі, але не в таблиці 12.4: {extra}"
    assert len(conf) >= 30, f"ТЗ вимагає 30+ валют у проектуванні, у реєстрі {len(conf)}"
    # Рівень відкривається на найраннішому етапі своїх валют; окремі валюти можуть бути пізніше.
    order = ["mvp", "stage2", "stage3", "reserve"]
    for level, meta in F["cur_roadmap"]["levels"].items():
        if meta["stage"] == "out_of_scope":
            continue
        stages = [c["stage"] for c in F["cur_roadmap"]["currencies"] if c["level"] == int(level)]
        assert stages, f"рівень {level} оголошений, але без валют"
        earliest = min(stages, key=order.index)
        assert earliest == meta["stage"], (
            f"рівень {level}: найранніший етап валют {earliest} != етапу рівня {meta['stage']}")
        for c in F["cur_roadmap"]["currencies"]:
            if c["level"] == int(level):
                assert order.index(c["stage"]) >= order.index(meta["stage"]), (
                    f"{c['code']}: етап {c['stage']} раніший за етап рівня {level} ({meta['stage']})")


def c11_active_currencies_are_mvp_subset(F):
    """C11. Активні валюти реєстру точно збігаються з валютами конфігурації MVP."""
    road = {c["code"]: c for c in F["cur_roadmap"]["currencies"]}
    active = {code for code, c in road.items() if c["status"] == "active"}
    enabled = {c["code"] for c in F["currencies"]["currencies"]}
    assert active == enabled, (
        f"активні в реєстрі {sorted(active)} != валюти конфігурації {sorted(enabled)}")
    for code in active:
        assert road[code]["stage"] == "mvp", f"{code}: активна валюта мусить належати до MVP"
    for code, c in road.items():
        if c["stage"] != "mvp":
            assert c["status"] != "active", f"{code}: валюта етапу {c['stage']} не може бути активною в MVP"
    base = F["cur_roadmap"]["base"]
    assert base == F["currencies"]["base"] == "EUR", "базова валюта реєстру й конфігурації мусить бути EUR"
    assert road[base]["level"] == 1, "базова валюта мусить бути на рівні 1"


def c12_minor_units(F):
    """C12. Кількість знаків після коми відповідає ISO 4217 і витримується в сумах фікстур."""
    road = {c["code"]: c for c in F["cur_roadmap"]["currencies"]}
    for code in ("JPY", "KRW"):
        assert road[code]["decimals"] == 0, f"{code} за ISO 4217 не має мінорних одиниць"
    for c in F["currencies"]["currencies"]:
        assert road[c["code"]]["decimals"] == c["decimals"], (
            f"{c['code']}: decimals у реєстрі {road[c['code']]['decimals']} != {c['decimals']} у конфігурації")
    for c in F["cur_roadmap"]["currencies"]:
        if c["is_crypto"]:
            assert c.get("internal_decimals", 0) >= c["decimals"], (
                f"{c['code']}: внутрішня точність обліку менша за точність відображення")
    for key in ("deal_ok", "deal_stale"):
        for field in ("price", "contract", "payment"):
            part = F[key].get(field)
            if not isinstance(part, dict) or "amount" not in part:
                continue
            code, amount = part["currency"], part["amount"]
            dec = road[code]["decimals"]
            assert round(amount, dec) == amount, (
                f"{key}.{field}: сума {amount} має більше знаків, ніж дозволяє {code} ({dec})")


def c13_crypto_assets_flagged(F):
    """C13. Криптоактиви позначені прапорцем і мережею, перелік ескроу — як у п. 12.5 ТЗ v2."""
    road = {c["code"]: c for c in F["cur_roadmap"]["currencies"]}
    for code, c in road.items():
        if c["kind"] == "fiat":
            assert c["is_crypto"] is False, f"{code}: фіатна валюта не може бути криптоактивом"
            assert "chain" not in c, f"{code}: фіатна валюта не має мережі"
        else:
            assert c["is_crypto"] is True, f"{code}: {c['kind']} мусить мати is_crypto=true"
            assert c.get("chain"), f"{code}: криптоактив без поля chain"
    allowed = F["cur_roadmap"]["escrow_allowed"]
    spec_escrow = spec2_escrow_currencies()
    assert sorted(allowed) == sorted(spec_escrow), (
        f"перелік ескроу {sorted(allowed)} != матриця 12.5 {sorted(spec_escrow)}")
    for code in allowed:
        assert road[code]["kind"] == "stablecoin", f"{code}: ескроу дозволений лише в стейблкоїнах"
    primary = F["currencies"]["escrow"]["primary"]
    assert road[primary]["status"] == "active", "основний актив ескроу мусить бути активним"
    assert F["cur_roadmap"]["settlement_only_currency"] == "EUR", "зведена звітність ведеться лише в EUR"


def l7_language_roadmap_matches_spec(F):
    """L7. Повний мовний реєстр збігається з трьома етапами й резервом п. 12.2 ТЗ v2."""
    spec = {
        "mvp": spec2_stage_tags("#### Етап 1"),
        "stage2": spec2_stage_tags("#### Етап 2"),
        "stage3": spec2_stage_tags("#### Етап 3"),
        "reserve": spec2_reserve_tags(),
    }
    assert len(spec["mvp"]) == 4, f"етап 1 мусить мати 4 мови, у ТЗ {len(spec['mvp'])}"
    assert len(spec["stage2"]) == 12, f"етап 2 мусить додавати 12 мов, у ТЗ {len(spec['stage2'])}"
    assert len(spec["stage3"]) == 8, f"етап 3 мусить додавати 8 мов, у ТЗ {len(spec['stage3'])}"
    assert len(spec["mvp"]) + len(spec["stage2"]) + len(spec["stage3"]) == 24, "разом мусить бути 24 мови"
    for stage, tags in spec.items():
        conf = [l["tag"] for l in F["lang_roadmap"]["locales"] if l["stage"] == stage]
        assert sorted(conf) == sorted(tags), (
            f"етап {stage}: реєстр {sorted(conf)} != ТЗ {sorted(tags)}")
    totals = F["lang_roadmap"]["stage_totals"]
    assert totals == {"mvp": 4, "stage2": 16, "stage3": 24}, f"нагромаджені суми етапів хибні: {totals}"
    langs = {l["language"] for l in F["lang_roadmap"]["locales"]}
    assert "ru" not in langs, "російська мова не входить до жодного етапу реєстру"


def l8_locale_tags_and_url_prefixes(F):
    """L8. Теги локалей валідні за BCP 47, а префікси URL унікальні (основа hreflang)."""
    tag_re = re.compile(r"^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$")
    tags, prefixes = set(), {}
    for l in F["lang_roadmap"]["locales"]:
        assert tag_re.match(l["tag"]), f"тег {l['tag']!r} не відповідає BCP 47"
        assert l["tag"] not in tags, f"тег {l['tag']} дублюється"
        tags.add(l["tag"])
        assert l["tag"].split("-")[0] == l["language"], (
            f"{l['tag']}: поле language={l['language']} не збігається з першим сабтегом")
        assert l["url_prefix"].startswith("/"), f"{l['tag']}: префікс URL мусить починатись з /"
        assert l["url_prefix"] not in prefixes, (
            f"префікс {l['url_prefix']} зайнятий локаллю {prefixes[l['url_prefix']]}")
        prefixes[l["url_prefix"]] = l["tag"]
    assert F["lang_roadmap"]["x_default"] == "en", "hreflang x-default мусить вести на англійську версію"


def l9_active_locales_are_mvp_subset(F):
    """L9. Активні локалі конфігурації — це рівно стабільні мови MVP реєстру."""
    mvp = [l for l in F["lang_roadmap"]["locales"] if l["stage"] == "mvp"]
    assert {l["language"] for l in mvp} == set(LANGS), (
        f"MVP реєстру {sorted(l['language'] for l in mvp)} != {LANGS}")
    assert set(F["locales"]["locales"]) == set(LANGS), "конфігурація локалей вийшла за склад MVP"
    for l in mvp:
        assert l["status"] == "stable", f"{l['tag']}: мова MVP не може бути в статусі {l['status']}"
    for l in F["lang_roadmap"]["locales"]:
        if l["stage"] != "mvp":
            assert l["language"] not in F["locales"]["locales"], (
                f"{l['tag']}: мова етапу {l['stage']} активована в конфігурації")
            assert l["status"] != "stable", f"{l['tag']}: незапущена мова не може бути stable"
    default = F["locales"]["default"]
    assert default in {l["language"] for l in mvp}, f"мова за замовчуванням {default} поза складом MVP"


def l10_fallback_chain_and_direction(F):
    """L10. Fallback-ланцюг завершується англійською без циклів, RTL позначено чесно."""
    by_lang = {}
    for l in F["lang_roadmap"]["locales"]:
        by_lang.setdefault(l["language"], l)
    assert F["lang_roadmap"]["fallback_language"] == "en", "fallback-мова системи — англійська (п. 12.10)"
    assert by_lang["en"]["fallback"] is None, "англійська — корінь ланцюга і не має fallback"
    for l in F["lang_roadmap"]["locales"]:
        seen, cur = [l["language"]], l
        while cur["fallback"] is not None:
            nxt = cur["fallback"]
            assert nxt in by_lang, f"{l['tag']}: fallback {nxt} відсутній у реєстрі"
            assert nxt not in seen, f"{l['tag']}: цикл у fallback-ланцюзі {seen + [nxt]}"
            seen.append(nxt)
            cur = by_lang[nxt]
        assert seen[-1] == "en", f"{l['tag']}: ланцюг {seen} не завершується англійською"
        expect = "rtl" if l["language"] in RTL_LANGS else "ltr"
        assert l["dir"] == expect, f"{l['tag']}: напрям письма мусить бути {expect}"
    rtl = [l["tag"] for l in F["lang_roadmap"]["locales"] if l["dir"] == "rtl"]
    assert rtl, "реєстр мусить містити хоч одну RTL-мову — інакше RTL-готовність нічим не перевіряється"


def l11_message_keys_in_registered_namespaces(F):
    """L11. Кожен ключ перекладу належить рівно одному простору імен з п. 12.10."""
    ns = F["namespaces"]["namespaces"]
    missing = [n for n in SPEC_NAMESPACES if n not in ns]
    assert not missing, f"у реєстрі бракує просторів імен із ТЗ: {missing}"
    owner = {}
    for name, prefixes in ns.items():
        for p in prefixes:
            assert p not in owner, f"префікс {p!r} належить і {owner[p]!r}, і {name!r}"
            owner[p] = name
    for l in LANGS:
        for key in F["messages"][l]:
            assert "." in key, f"{l}: ключ {key!r} без простору імен"
            prefix = key.split(".", 1)[0]
            assert prefix in owner, f"{l}: ключ {key!r} поза зареєстрованими просторами імен"


def l12_icu_templates_and_plurals(F):
    """L12. Шаблони ICU розбираються, а категорії множини відповідають CLDR."""
    for l in LANGS:
        for key, value in F["messages"][l].items():
            try:
                used = icu_scan(value)
            except AssertionError as ex:
                raise AssertionError(f"{l}, ключ {key}: {ex}")
            bad = sorted(used - set(CLDR_PLURALS[l]))
            assert not bad, f"{l}, ключ {key}: категорії {bad} не існують у CLDR для цієї мови"
    for l in F["lang_roadmap"]["locales"]:
        lang = l["language"]
        assert lang in CLDR_PLURALS, f"{l['tag']}: немає еталонних категорій CLDR для мови"
        assert l["plural_categories"] == CLDR_PLURALS[lang], (
            f"{l['tag']}: категорії множини {l['plural_categories']} != CLDR {CLDR_PLURALS[lang]}")


CHECKS = [c1_currency_list_matches_spec, c2_single_base_currency, c3_escrow_assets,
          c4_price_not_equal_payment, c5_escrow_equals_payment_and_conditions, c6_conversion_log,
          c7_stale_rate_notice, c8_locale_formatting, c9_order_independent_of_display_currency,
          c10_currency_roadmap_matches_spec, c11_active_currencies_are_mvp_subset,
          c12_minor_units, c13_crypto_assets_flagged,
          l1_message_key_parity, l2_placeholder_parity, l3_glossary_terms_preserved,
          l4_mvp_languages_match_spec, l5_machine_translation_marker, l6_original_language_field,
          l7_language_roadmap_matches_spec, l8_locale_tags_and_url_prefixes,
          l9_active_locales_are_mvp_subset, l10_fallback_chain_and_direction,
          l11_message_keys_in_registered_namespaces, l12_icu_templates_and_plurals]

IDS = {f.__name__: f.__doc__.split(".")[0] for f in CHECKS}

# --- мутації: кожна мусить бути відхилена схемою або перевіркою -----------

def m(path, fn):
    return (path, fn)


MUTATIONS = [
    ("C1: валюту вилучено з конфігурації", lambda F: F["currencies"]["currencies"].pop(4)),
    ("C2: базова валюта не EUR", lambda F: F["currencies"].update(base="USD")),
    ("C2: роль base у двох валют", lambda F: F["currencies"]["currencies"][1]["roles"].append("base")),
    ("C3: основний актив ескроу USDT", lambda F: F["currencies"]["escrow"].update(primary="USDT")),
    ("C3: ескроу у фіатній валюті", lambda F: F["currencies"]["currencies"][2]["roles"].append("escrow")),
    ("C4: платіж не відповідає курсу", lambda F: F["deal_ok"]["payment"].update(amount=2400.0)),
    ("C4: валюта договору зникла", lambda F: F["deal_ok"].pop("contract")),
    ("C5: ескроу вивільнено без умов", lambda F: F["deal_ok"]["escrow"].update(release_conditions=[], released=True)),
    ("C5: сума ескроу менша за платіж", lambda F: F["deal_ok"]["escrow"].update(amount=1000.0)),
    ("C6: журнал конвертацій порожній", lambda F: F["deal_ok"].update(conversion_log=[])),
    ("C6: у журналі інший курс", lambda F: F["deal_ok"]["conversion_log"][0].update(rate=1.2)),
    ("C6: у записі журналу немає джерела", lambda F: F["deal_ok"]["conversion_log"][0].pop("source")),
    ("C7: застарілий курс без позначки", lambda F: F["deal_stale"]["fx"].pop("display_stale_notice")),
    ("C7: курс нульовий", lambda F: F["deal_stale"]["fx"].update(rate=0)),
    ("C8: неправильний зразок форматування", lambda F: F["locales"]["locales"]["de"].update(sample_2400="2 400,00\u00a0EUR")),
    ("C8: усі локалі з однаковим форматом", lambda F: [loc.update(group_sep=",", decimal_sep=".") for loc in F["locales"]["locales"].values()]),
    ("C9: курс відображення нульовий", lambda F: F["routes"]["display_rates"].update(UAH=0)),
    ("C9: маршрут без вартості бере участь у сортуванні", lambda F: F["routes"]["routes"][3].update(cost_base_eur=10.0)),
    ("L1: ключ відсутній у німецькому каталозі", lambda F: F["messages"]["de"].pop("escrow.locked")),
    ("L1: порожній переклад", lambda F: F["messages"]["pl"].update({"search.submit": "  "})),
    ("L2: втрачена підстановка", lambda F: F["messages"]["en"].update({"deal.price_vs_payment": "Price {price}, payment at rate {rate}"})),
    ("L2: додана підстановка", lambda F: F["messages"]["uk"].update({"fx.stale_notice": "Курс застарілий {fixed_at} {extra}"})),
    ("L3: термін глосарію перекладено", lambda F: F["messages"]["uk"].update({"terms.incoterms": "Умови постачання Інкотермс"})),
    ("L3: термін ADR вилучено з перекладу", lambda F: F["messages"]["de"].update({"terms.adr": "Gefahrklasse"})),
    ("L4: локаль поза складом MVP", lambda F: F["locales"]["locales"]["de"].update(language="ru")),
    ("L5: позначка машинного перекладу без оригіналу", lambda F: F["messages"]["en"].update({"chat.machine_translation_notice": "Machine translation."})),
    ("L6: поле валюти ставки зникло", lambda F: [F["messages"][l].pop("lot.currency") for l in LANGS]),
    # — мутації повного реєстру ТЗ v2 —
    ("C10: валюту рівня 4 вилучено з реєстру",
     lambda F: F["cur_roadmap"].update(
         currencies=[c for c in F["cur_roadmap"]["currencies"] if c["code"] != "CHF"])),
    ("C10: у реєстрі валюта, якої немає в ТЗ",
     lambda F: F["cur_roadmap"]["currencies"].append(
         {"code": "XAU", "level": 4, "kind": "fiat", "decimals": 2, "status": "disabled",
          "stage": "stage2", "is_crypto": False})),
    ("C10: рівень валюти розійшовся з таблицею 12.4",
     lambda F: [c.update(level=5) for c in F["cur_roadmap"]["currencies"] if c["code"] == "GBP"]),
    ("C10: рівень відкривається раніше, ніж оголошено",
     lambda F: [c.update(stage="stage2") for c in F["cur_roadmap"]["currencies"] if c["level"] == 5]),
    ("C11: активну валюту MVP виключено в реєстрі",
     lambda F: [c.update(status="disabled") for c in F["cur_roadmap"]["currencies"] if c["code"] == "UAH"]),
    ("C11: валюту етапу 2 позначено активною",
     lambda F: [c.update(status="active") for c in F["cur_roadmap"]["currencies"] if c["code"] == "CHF"]),
    ("C12: JPY з двома знаками після коми",
     lambda F: [c.update(decimals=2) for c in F["cur_roadmap"]["currencies"] if c["code"] == "JPY"]),
    ("C12: decimals у реєстрі розійшлись з конфігурацією",
     lambda F: [c.update(decimals=3) for c in F["cur_roadmap"]["currencies"] if c["code"] == "EUR"]),
    ("C12: стейблкоїн без запасу внутрішньої точності",
     lambda F: [c.update(internal_decimals=1) for c in F["cur_roadmap"]["currencies"] if c["code"] == "USDT"]),
    ("C13: стейблкоїн без мережі",
     lambda F: [c.pop("chain") for c in F["cur_roadmap"]["currencies"] if c["code"] == "USDC"]),
    ("C13: фіат позначено криптоактивом",
     lambda F: [c.update(is_crypto=True) for c in F["cur_roadmap"]["currencies"] if c["code"] == "PLN"]),
    ("C13: у переліку ескроу зʼявилась фіатна валюта",
     lambda F: F["cur_roadmap"]["escrow_allowed"].append("EUR")),
    ("L7: мову етапу 2 вилучено з реєстру",
     lambda F: F["lang_roadmap"].update(
         locales=[l for l in F["lang_roadmap"]["locales"] if l["tag"] != "cs-CZ"])),
    ("L7: до реєстру додано російську локаль",
     lambda F: F["lang_roadmap"]["locales"].append(
         {"tag": "ru-RU", "language": "ru", "name": "Російська", "stage": "stage2",
          "status": "planned", "dir": "ltr", "fallback": "en", "url_prefix": "/ru",
          "plural_categories": ["one", "few", "many", "other"]})),
    ("L8: дві локалі з однаковим префіксом URL",
     lambda F: F["lang_roadmap"]["locales"][1].update(url_prefix=F["lang_roadmap"]["locales"][0]["url_prefix"])),
    ("L8: поле language не відповідає тегу локалі",
     lambda F: F["lang_roadmap"]["locales"][2].update(language="cs")),
    ("L9: мову MVP позначено beta",
     lambda F: F["lang_roadmap"]["locales"][0].update(status="beta")),
    ("L9: мову етапу 3 позначено стабільною без активації",
     lambda F: [l.update(status="stable") for l in F["lang_roadmap"]["locales"] if l["stage"] == "stage3"][:1]),
    ("L10: цикл у fallback-ланцюзі",
     lambda F: [l.update(fallback="pl" if l["language"] == "uk" else "uk")
               for l in F["lang_roadmap"]["locales"] if l["language"] in ("uk", "pl")]),
    ("L10: RTL-мову позначено як LTR",
     lambda F: [l.update(dir="ltr") for l in F["lang_roadmap"]["locales"] if l["language"] == "ar"]),
    ("L11: ключ поза зареєстрованим простором імен",
     lambda F: [F["messages"][l].update({"random.key": "x"}) for l in LANGS]),
    ("L11: простір імен із ТЗ вилучено з реєстру",
     lambda F: F["namespaces"]["namespaces"].pop("glossary")),
    ("L12: незбалансовані дужки ICU",
     lambda F: [F["messages"][l].update({"escrow.locked": "{amount"}) for l in LANGS]),
    ("L12: невідома категорія множини в шаблоні",
     lambda F: [F["messages"][l].update({"escrow.locked": "{n, plural, dual{x} other{y}}"}) for l in LANGS]),
    ("L12: блок plural без варіанта other",
     lambda F: [F["messages"][l].update({"escrow.locked": "{n, plural, one{x} few{y}}"}) for l in LANGS]),
    ("L12: категорії множини польської не за CLDR",
     lambda F: [l.update(plural_categories=["one", "other"])
               for l in F["lang_roadmap"]["locales"] if l["language"] == "pl"]),
]

DEFS = {"currencies": "currencies", "locales": "locales", "glossary": "glossary",
        "deal_ok": "deal", "deal_stale": "deal", "routes": "routes_display",
        "lang_roadmap": "language_roadmap", "cur_roadmap": "currency_roadmap",
        "namespaces": "namespaces"}


def validate_all(F):
    out = []
    for key, defname in DEFS.items():
        for e in errs(defname, F[key]):
            out.append(f"{key}: {e.message}")
    for l in LANGS:
        for e in errs("messages", F["messages"][l]):
            out.append(f"messages/{l}: {e.message}")
    return out


def run_checks(F):
    failures = []
    for fn in CHECKS:
        try:
            fn(F)
        except AssertionError as ex:
            failures.append(f"{IDS[fn.__name__]}: {ex}")
        except Exception as ex:  # структурна поломка теж є провалом сценарію
            failures.append(f"{IDS[fn.__name__]}: {type(ex).__name__}: {ex}")
    return failures


def main():
    bad = validate_all(FIX)
    print("схема фікстур:", "OK" if not bad else "ПОМИЛКИ")
    for b in bad:
        print("  ", b)

    failures = run_checks(FIX)
    for fn in CHECKS:
        name = IDS[fn.__name__]
        hit = [f for f in failures if f.startswith(name + ":")]
        print(f"{name:4s} {fn.__doc__.split('. ', 1)[1][:72]:74s} {'OK' if not hit else 'ПРОВАЛ'}")
    for f in failures:
        print("  ", f)

    print("\nмутаційне тестування:")
    not_caught = []
    for title, mut in MUTATIONS:
        F = copy.deepcopy(FIX)
        mut(F)
        caught = bool(validate_all(F)) or bool(run_checks(F))
        if not caught:
            not_caught.append(title)
        print(f"  {'відхилено' if caught else 'НЕ ВИЯВЛЕНО':12s} {title}")

    total = len(MUTATIONS)
    ncur = sum(1 for f in CHECKS if f.__name__.startswith("c"))
    print(f"\nсценаріїв: {len(CHECKS)} (валютних {ncur}, мовних {len(CHECKS) - ncur}), провалів: {len(failures)}")
    print(f"мутацій: {total}, виявлено: {total - len(not_caught)}, не виявлено: {len(not_caught)}, "
          f"покриття: {round(100 * (total - len(not_caught)) / total)}%")
    return 1 if failures or not_caught or bad else 0


if __name__ == "__main__":
    sys.exit(main())
