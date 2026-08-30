#!/usr/bin/env python3
"""Прогін валютних і мовних сценаріїв (рамкове ТЗ, розділи 13.6 і 14.7).

Не потребує ні бази, ні застосунку: читає фікстури з i18n/, схему
schemas/i18n.schema.json і самі таблиці ТЗ, тому розбіжність між документом
і конфігурацією падає одразу. Мутаційне тестування доводить, що кожна
перевірка справді спрацьовує.

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
LANGS = ["uk", "en", "pl", "de"]

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
}
SPEC_TEXT = open(SPEC, encoding="utf-8").read()


def spec_section(header):
    a = SPEC_TEXT.index(header)
    b = SPEC_TEXT.index("\n### ", a + len(header))
    return SPEC_TEXT[a:b]


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


CHECKS = [c1_currency_list_matches_spec, c2_single_base_currency, c3_escrow_assets,
          c4_price_not_equal_payment, c5_escrow_equals_payment_and_conditions, c6_conversion_log,
          c7_stale_rate_notice, c8_locale_formatting, c9_order_independent_of_display_currency,
          l1_message_key_parity, l2_placeholder_parity, l3_glossary_terms_preserved,
          l4_mvp_languages_match_spec, l5_machine_translation_marker, l6_original_language_field]

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
]

DEFS = {"currencies": "currencies", "locales": "locales", "glossary": "glossary",
        "deal_ok": "deal", "deal_stale": "deal", "routes": "routes_display"}


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
    print(f"\nсценаріїв: {len(CHECKS)} (валютних 9, мовних 6), провалів: {len(failures)}")
    print(f"мутацій: {total}, виявлено: {total - len(not_caught)}, не виявлено: {len(not_caught)}, "
          f"покриття: {round(100 * (total - len(not_caught)) / total)}%")
    return 1 if failures or not_caught or bad else 0


if __name__ == "__main__":
    sys.exit(main())
