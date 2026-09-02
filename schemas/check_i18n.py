"""Перевірка i18n-контракту (валютна та мовна модель): рамкове ТЗ, розд. 13-14;
ТЗ v2, розд. 12; схема schemas/i18n.schema.json.

Абсолютний шлях тут неприпустимий - у CI скрипт має читати схему й фікстури
саме з поточної копії репозиторію, інакше перевірка валідує чужі файли й
пропускає зміни в PR (той самий принцип, що й у check_schema.py).
"""
import json, os, re, sys
from pathlib import Path
from jsonschema import Draft202012Validator

# Консоль Windows (cp1251) не має деяких символів UTF-8 (наприклад, "×") -
# без цього друк падає з UnicodeEncodeError замість показу результату.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("CONTRACT_ROOT") or str(Path(__file__).resolve().parent.parent) + "/"
schema = json.load(open(BASE + "schemas/i18n.schema.json", encoding="utf-8"))
Draft202012Validator.check_schema(schema)


def sub_validator(def_name):
    """Валідатор для одного $defs/<def_name>, з доступом до всієї схеми для $ref."""
    sub = {**schema["$defs"][def_name], "$defs": schema["$defs"]}
    return Draft202012Validator(sub)


def load(path):
    return json.load(open(BASE + path, encoding="utf-8"))


FILES = {
    "i18n/locales.json": "locales",
    "i18n/currencies.json": "currencies",
    "i18n/glossary.json": "glossary",
    "i18n/namespaces.json": "namespaces",
    "i18n/deal-luts-hamburg.json": "deal",
    "i18n/deal-stale-rate.json": "deal",
    "i18n/routes-display.json": "routes_display",
    "i18n/language-roadmap.json": "language_roadmap",
    "i18n/currency-roadmap.json": "currency_roadmap",
}

fail = 0
docs = {}
print("Структурна валідація фікстур проти schemas/i18n.schema.json:")
for path, def_name in FILES.items():
    doc = load(path)
    docs[path] = doc
    errs = list(sub_validator(def_name).iter_errors(doc))
    ok = not errs
    fail += not ok
    print(f"  {'OK  ' if ok else 'FAIL'} {path}  (=> $defs/{def_name})")
    for e in errs:
        print(f"        {'/'.join(str(p) for p in e.path)}: {e.message}")

locales = docs["i18n/locales.json"]
currencies = docs["i18n/currencies.json"]
glossary = docs["i18n/glossary.json"]
namespaces = docs["i18n/namespaces.json"]
deal_ok = docs["i18n/deal-luts-hamburg.json"]
deal_stale = docs["i18n/deal-stale-rate.json"]
routes_display = docs["i18n/routes-display.json"]
lang_roadmap = docs["i18n/language-roadmap.json"]
curr_roadmap = docs["i18n/currency-roadmap.json"]

# --- витяг фактичного стану index.html, щоб фікстури не розійшлися з кодом ---
index_html = open(BASE + "index.html", encoding="utf-8").read()
m = re.search(r'var LANGS ?= ?(\[[^\]]*\])', index_html)
LIVE_LANGS = json.loads(m.group(1)) if m else []
m = re.search(r'var CURRENCIES = (\[[^\]]*\])', index_html)
LIVE_CURRENCIES = json.loads(m.group(1)) if m else []

ISO4217_ZERO_DECIMAL = {"JPY", "KRW"}


def c1_currencies_match_live_code():
    """C1: i18n/currencies.json - це саме валюти, активні в index.html (+ ескроу)."""
    fixture_active = {c["code"] for c in currencies["currencies"] if c.get("status") == "active"}
    if fixture_active != set(LIVE_CURRENCIES):
        return f"активні валюти фікстури {sorted(fixture_active)} != CURRENCIES у index.html {sorted(LIVE_CURRENCIES)}"


def c2_base_matches_across_files():
    """C2: базова валюта однакова в currencies.json і currency-roadmap.json."""
    if currencies["base"] != curr_roadmap["base"]:
        return f"base {currencies['base']!r} != {curr_roadmap['base']!r}"


def c3_escrow_primary_is_usdc():
    if currencies["escrow"]["primary"] != "USDC":
        return "escrow.primary не USDC"
    if "USDT" not in currencies["escrow"]["secondary"]:
        return "USDT відсутній серед додаткових активів ескроу"


def c4_deal_fx_consistent():
    """C4: сума платежу відповідає ставці ×курс (розд. 13.2, приклад Луцьк-Гамбург)."""
    d = deal_ok
    expected = round(d["price"]["amount"] * d["fx"]["rate"], 2)
    got = round(d["payment"]["amount"], 2)
    if abs(expected - got) > 0.01:
        return f"payment.amount={got}, очікується price.amount*fx.rate={expected}"
    if d["price"]["currency"] == d["payment"]["currency"]:
        return "валюта ставки і валюта платежу мають бути різними (демонструє розд. 12.6)"


def c5_escrow_release_documented():
    er = deal_ok["escrow"]
    if not er or not er["release_conditions"]:
        return "умови вивільнення ескроу не задокументовано"
    if er["released"] is not True:
        return "приклад Луцьк-Гамбург має бути завершеною (released=true) угодою"


def c6_conversion_log_present():
    for d, name in [(deal_ok, "luts-hamburg"), (deal_stale, "stale-rate")]:
        if not d["conversion_log"]:
            return f"{name}: порожній conversion_log"
        for row in d["conversion_log"]:
            if not row["source"] or not row["fixed_at"]:
                return f"{name}: запис журналу без джерела/часу фіксації"


def c7_stale_rate_flagged():
    fx = deal_stale["fx"]
    if not fx["stale"]:
        return "deal-stale-rate.json мав би демонструвати stale=true"
    if not fx.get("display_stale_notice"):
        return "stale=true без display_stale_notice (розд. 13.3 порушено)"
    if deal_stale["escrow"] is not None:
        return "за застарілого курсу нову угоду фіксувати не можна - escrow має бути null"


def c8_same_amount_across_locales():
    """C8: 2400 EUR у всіх чотирьох локалях - те саме число, різне форматування."""
    for lang, loc in locales["locales"].items():
        digits = re.sub(r"[^0-9]", "", loc["sample_2400"].split(loc["decimal_sep"])[0])
        if digits != "2400" and digits != "24" + "00":
            return f"{lang}: sample_2400={loc['sample_2400']!r} не зводиться до 2400"
        if "EUR" not in loc["sample_2400"]:
            return f"{lang}: sample_2400 не містить коду валюти EUR"


def c9_routes_cost_known_consistent():
    for r in routes_display["routes"]:
        if r["cost_known"] and r["cost_base_eur"] is None:
            return f"{r['route_id']}: cost_known=true, але cost_base_eur=null"
        if not r["cost_known"] and r["cost_base_eur"] is not None:
            return f"{r['route_id']}: cost_known=false, але cost_base_eur заповнено (вигадане значення)"


def c10_roadmap_covers_all_levels():
    levels_used = {c["level"] for c in curr_roadmap["currencies"]}
    declared_levels = {int(k) for k in curr_roadmap["levels"]}
    missing = declared_levels - levels_used - {9}  # рівень 9 (власний токен) навмисно без коду
    if missing:
        return f"рівні без жодної валюти (крім 9): {sorted(missing)}"
    codes = [c["code"] for c in curr_roadmap["currencies"]]
    if len(codes) != len(set(codes)):
        return "дублікати кодів валют у currency-roadmap.json"


def c11_active_sets_match():
    fixture_active = {c["code"] for c in currencies["currencies"] if c.get("status") == "active"}
    roadmap_active = {c["code"] for c in curr_roadmap["currencies"] if c["status"] == "active"}
    if fixture_active != roadmap_active:
        return f"активні в currencies.json {sorted(fixture_active)} != активні в currency-roadmap.json {sorted(roadmap_active)}"


def c12_decimals_follow_iso4217():
    for c in curr_roadmap["currencies"]:
        if c["kind"] == "fiat":
            expected = 0 if c["code"] in ISO4217_ZERO_DECIMAL else 2
            if c["decimals"] != expected:
                return f"{c['code']}: decimals={c['decimals']}, очікується {expected} за ISO 4217"


def c13_crypto_fields_and_settlement():
    for c in curr_roadmap["currencies"]:
        if c["is_crypto"] and "chain" not in c:
            return f"{c['code']}: is_crypto=true без chain"
        if not c["is_crypto"] and "chain" in c:
            return f"{c['code']}: фіатна валюта не повинна мати chain"
    if set(curr_roadmap["escrow_allowed"]) - {"USDC", "USDT", "EURC"}:
        return "escrow_allowed містить актив поза USDC/USDT/EURC"
    if curr_roadmap["settlement_only_currency"] != "EUR":
        return "зведена звітність має вестись лише в EUR"


def l1_mvp_locales_match_live_code():
    mvp_langs = sorted(l["language"] for l in lang_roadmap["locales"] if l["stage"] == "mvp")
    if mvp_langs != sorted(LIVE_LANGS):
        return f"мови MVP у roadmap {mvp_langs} != LANGS у index.html {sorted(LIVE_LANGS)}"
    if sorted(locales["locales"].keys()) != sorted(LIVE_LANGS):
        return f"ключі i18n/locales.json {sorted(locales['locales'].keys())} != LANGS {sorted(LIVE_LANGS)}"


def l3_glossary_terms_frozen():
    seen = set()
    for t in glossary["terms"]:
        if not t["do_not_translate"]:
            return f"{t['term']}: термін глосарія має бути do_not_translate=true (розд. 12.8)"
        if t["term"] in seen:
            return f"{t['term']}: дублікат у глосарії"
        seen.add(t["term"])


def l4_full_roadmap_no_russian():
    stages = {"mvp": 4, "stage2": 16, "stage3": 24}
    for stage, cumulative in stages.items():
        count = sum(1 for l in lang_roadmap["locales"] if l["stage"] in
                     (["mvp"] if stage == "mvp" else
                      ["mvp", "stage2"] if stage == "stage2" else
                      ["mvp", "stage2", "stage3"]))
        if count != cumulative:
            return f"етап {stage}: {count} мов, очікується {cumulative} (наростаючим підсумком)"
    if any(l["language"] == "ru" for l in lang_roadmap["locales"]):
        return "російська мова не повинна фігурувати в жодному переліку (розд. 14.2)"


def l7_roadmap_locales_at_least_24():
    if len(lang_roadmap["locales"]) < 24:
        return "менше 24 локалей у language-roadmap.json"
    tags = [l["tag"] for l in lang_roadmap["locales"]]
    if len(tags) != len(set(tags)):
        return "дублікати тегів локалі"


def l8_url_prefixes_unique():
    prefixes = [l["url_prefix"] for l in lang_roadmap["locales"]]
    if len(prefixes) != len(set(prefixes)):
        return "дублікати url_prefix"


def l9_mvp_locales_are_stable():
    for l in lang_roadmap["locales"]:
        if l["stage"] == "mvp" and l["status"] != "stable":
            return f"{l['tag']}: мова MVP має статус stable, а не {l['status']}"
        if l["stage"] != "mvp" and l["status"] == "stable":
            return f"{l['tag']}: мова поза MVP не може мати статус stable"


def l10_fallback_chain_ends_in_en():
    for l in lang_roadmap["locales"]:
        if l["language"] != "en" and l["fallback"] != "en":
            return f"{l['tag']}: fallback має вести на en, а не {l['fallback']!r}"
    rtl = [l for l in lang_roadmap["locales"] if l["dir"] == "rtl"]
    if not rtl:
        return "у переліку немає жодної RTL-мови (арабська, п. 12.2, резерв)"


def l11_namespaces_cover_seven_and_no_overlap():
    if len(namespaces["namespaces"]) < 7:
        return "менше семи просторів імен"
    seen = {}
    for ns, prefixes in namespaces["namespaces"].items():
        for p in prefixes:
            if p in seen:
                return f"префікс {p!r} одночасно в {seen[p]!r} і {ns!r}"
            seen[p] = ns


def l12_plural_categories_valid():
    valid = {"zero", "one", "two", "few", "many", "other"}
    for l in lang_roadmap["locales"]:
        cats = l["plural_categories"]
        if "other" not in cats:
            return f"{l['tag']}: у plural_categories немає обов'язкової категорії other"
        if not set(cats) <= valid:
            return f"{l['tag']}: невідома категорія множини серед {cats}"


CHECKS = [
    ("C1", c1_currencies_match_live_code),
    ("C2", c2_base_matches_across_files),
    ("C3", c3_escrow_primary_is_usdc),
    ("C4", c4_deal_fx_consistent),
    ("C5", c5_escrow_release_documented),
    ("C6", c6_conversion_log_present),
    ("C7", c7_stale_rate_flagged),
    ("C8", c8_same_amount_across_locales),
    ("C9", c9_routes_cost_known_consistent),
    ("C10", c10_roadmap_covers_all_levels),
    ("C11", c11_active_sets_match),
    ("C12", c12_decimals_follow_iso4217),
    ("C13", c13_crypto_fields_and_settlement),
    ("L1", l1_mvp_locales_match_live_code),
    ("L3", l3_glossary_terms_frozen),
    ("L4", l4_full_roadmap_no_russian),
    ("L7", l7_roadmap_locales_at_least_24),
    ("L8", l8_url_prefixes_unique),
    ("L9", l9_mvp_locales_are_stable),
    ("L10", l10_fallback_chain_ends_in_en),
    ("L11", l11_namespaces_cover_seven_and_no_overlap),
    ("L12", l12_plural_categories_valid),
]

# L2, L5, L6 з розд. 14.7/14.8 рамкового ТЗ перевіряють поведінку живого
# застосунку (плейсхолдери в реальних повідомленнях, позначку машинного
# перекладу в чаті, юридично значущу мову договору) - у цьому репозиторії
# немає окремих файлів server/тестів для цього рівня, тож чесніше явно
# позначити їх як N/A, ніж імітувати перевірку, яка нічого не тестує.
NOT_APPLICABLE = {
    "L2": "плейсхолдини перевіряються лише в реальних рядках повідомлень (index.html), а не в цих JSON-фікстурах",
    "L5": "потребує живого AI-чату (server/) - поза обсягом статичних i18n-фікстур",
    "L6": "юридично значуща мова договору стосується шаблонів документів, яких ще немає в репозиторії",
}

print("\nСценарії C1-C13, L1-L12:")
for cid, fn in CHECKS:
    msg = fn()
    ok = msg is None
    fail += not ok
    print(f"  {'OK  ' if ok else 'FAIL'} {cid:4} {fn.__doc__.splitlines()[0] if fn.__doc__ else ''}")
    if msg:
        print(f"        {msg}")
for cid, reason in NOT_APPLICABLE.items():
    print(f"  N/A  {cid:4} {reason}")

total = len(CHECKS) + len(NOT_APPLICABLE)
print(f"\nПеревірок: {total} ({len(CHECKS)} виконано, {len(NOT_APPLICABLE)} N/A), провалів: {fail}")
sys.exit(1 if fail else 0)
