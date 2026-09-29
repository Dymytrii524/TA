#!/usr/bin/env python3
"""Документація не має відставати від конвеєрів (ТЗ, розділи A.13.4 і 13.6).

Числа в ТЗ старіють мовчки: правило гілки виросло з трьох перевірок до дванадцяти,
набір правил - з R1-R10 до R1-R14, сценаріїв pull request стало девʼятнадцять,
а речення в документах лишалися з попередньої редакції. Око цього не бачить.

Джерело істини - не текст, а самі артефакти: `ci/ruleset-contract.json`,
конвеєри в `ci/*.yml` і списки сценаріїв у прогонах. Цей прогін виводить
фактичні числа з них і звіряє з твердженнями в документах.

Історичні згадки дозволені, але лише явні: рядок або його підрозділ мусить
бути позначений словом-маркером («Історія», «перейменовано», «попередньої
редакції», «редакції 1», «Увага при впровадженні»). Інакше стара цифра -
дефект, а не спогад.

Коди виходу: 0 - документація узгоджена, 1 - розбіжності.
`--self-test` прогоняє навмисні мутації документів: кожна мусить бути виявлена.
"""
import ast
import os
import re
import shutil
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import json

import yaml

ROOT = os.environ.get("CONTRACT_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOCS = [
    "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md",
    "ТЗ-рамкове-логістична-біржа.md",
    "ТЗ-логістична-біржа-v2-мови-валюти.md",
    "sprint-0-backend/ТЗ-бекенд-Спринт-0.md",
    "sprint-0-backend/ТЗ-верифікація-контрагентів.md",
    "ci/README.md",
]

HISTORY_MARKERS = ("Історія", "історичн", "перейменовано", "попередньої редакції",
                   "редакції 1", "Увага при впровадженні", "Раніше")

WORDS = {"одна": 1, "одне": 1, "один": 1, "одного": 1, "дві": 2, "три": 3, "чотири": 4, "пʼять": 5, "п'ять": 5, "шість": 6,
         "сім": 7, "вісім": 8, "девʼять": 9, "дев'ять": 9, "десять": 10,
         "одинадцять": 11, "дванадцять": 12, "тринадцять": 13, "чотирнадцять": 14,
         "пʼятнадцять": 15, "шістнадцять": 16, "сімнадцять": 17, "вісімнадцять": 18,
         "девʼятнадцять": 19, "дев'ятнадцять": 19, "двадцять": 20,
         "трьох": 3, "чотирьох": 4, "пʼятьох": 5, "шести": 6, "семи": 7, "восьми": 8,
         "девʼяти": 9, "десяти": 10, "одинадцяти": 11, "дванадцяти": 12, "тринадцяти": 13,
         "чотирнадцяти": 14, "шістнадцяти": 16, "вісімнадцяти": 18, "девʼятнадцяти": 19,
         "двадцяти": 20}


def number(token):
    """Число словом або цифрами; None, якщо не розпізнано."""
    token = token.strip().lower()
    if token.isdigit():
        return int(token)
    return WORDS.get(token)


# Тільки цифри та відомі числівники: інакше перший-ліпший іменник з'їдає збіг
# і перевірка мовчки пропускає застаріле число.
NUM = r"(\d+|" + "|".join(sorted(WORDS, key=len, reverse=True)) + r")"


# --- фактичні числа з артефактів ------------------------------------------

def _list_len(path, name):
    for node in ast.parse(open(os.path.join(ROOT, path), encoding="utf-8").read()).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == name:
            return len(node.value.elts)
    raise AssertionError(f"{path}: не знайдено список {name}")


def facts():
    rs = json.load(open(os.path.join(ROOT, "ci", "ruleset-contract.json"), encoding="utf-8"))
    contexts = [c["context"] for r in rs["rules"] if r["type"] == "required_status_checks"
                for c in r["parameters"]["required_status_checks"]]
    ui = open(os.path.join(ROOT, "ci", "verify_heromode.js"), encoding="utf-8").read()
    return {
        "contexts": contexts,
        "required": len(contexts),
        "rules": _list_len("ci/check_ruleset.py", "CHECKS"),
        "rule_mutations": _list_len("ci/check_ruleset.py", "MUTATIONS"),
        "pr_scenarios": _list_len("ci/pr_simulation.py", "SCENARIOS"),
        "i18n_scenarios": _list_len("schemas/check_i18n.py", "CHECKS"),
        "i18n_mutations": _list_len("schemas/check_i18n.py", "MUTATIONS"),
        "ui_scenarios": max(int(x) for x in re.findall(r"\bU(\d+)[:.]", ui)),
        "pr_params": next((r["parameters"] for r in rs["rules"]
                           if r["type"] == "pull_request"), {}),
    }


# --- читання документів ----------------------------------------------------

def blocks(text):
    """Пари (рядок, чи дозволена в ньому історична згадка).

    Підрозділ визначається жирним лідом на початку абзацу (`**Назва.**`):
    усе до наступного такого ліда або заголовка успадковує його маркер.
    """
    label = ""
    region = False           # історичний підрозділ триває до наступного заголовка
    out = []
    for line in text.split("\n"):
        lead = re.match(r"\*\*(.+?)\*\*", line.strip())
        if line.startswith("#"):
            label, region = line, False
        elif lead:
            label = lead.group(1)
            if any(m in label for m in HISTORY_MARKERS):
                region = True
        hist = region or any(m in line or m in label for m in HISTORY_MARKERS)
        out.append((line, hist))
    return out


def docs():
    for rel in DOCS:
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            yield rel, blocks(open(path, encoding="utf-8").read())


# --- перевірки -------------------------------------------------------------

def d1_no_stale_groups(f, fails):
    """D1. Застаріла назва обовʼязкової перевірки i18n лише в історичних абзацах.

    Заголовки розділів «Сценарії C1-C9» коректні: це підмножина MVP. Дефект -
    лише стара назва перевірки в правилі гілки.
    """
    for rel, lines in docs():
        for i, (line, hist) in enumerate(lines, 1):
            if re.search(r"Валютні та мовні сценарії C1[-–]C9", line) and not hist:
                fails.append(f"D1: {rel}:{i} застаріла назва групи сценаріїв поза історичним абзацом")


def d2_contexts_documented(f, fails):
    """D2. Кожна обовʼязкова перевірка названа дослівно в ТЗ і в ci/README.md."""
    texts = {rel: "\n".join(l for l, _ in lines) for rel, lines in docs()}
    for ctx in f["contexts"]:
        if not any(ctx in t for t in texts.values()):
            fails.append(f"D2: перевірка {ctx!r} із правила гілки не описана в жодному документі")


def d3_required_count(f, fails):
    """D3. Твердження про кількість обовʼязкових перевірок збігається з правилом."""
    pat = re.compile(NUM + r"\s+обовʼязков\w*\s+перевір\w*"
                     r"|обовʼязков\w*\s+перевір\w*\s+" + NUM, re.IGNORECASE)
    for rel, lines in docs():
        for i, (line, hist) in enumerate(lines, 1):
            if hist:
                continue
            for m in pat.finditer(line):
                n = number(m.group(1) or m.group(2))
                if n is not None and n != f["required"]:
                    fails.append(f"D3: {rel}:{i} сказано {n} обовʼязкових перевірок, у правилі {f['required']}")


def d4_rule_counts(f, fails):
    """D4. Номери правил R1-RN і кількість мутацій прогону правила актуальні."""
    for rel, lines in docs():
        for i, (line, hist) in enumerate(lines, 1):
            if hist:
                continue
            for m in re.finditer(r"R1\s*[-–]\s*R(\d+)", line):
                if int(m.group(1)) != f["rules"]:
                    fails.append(f"D4: {rel}:{i} діапазон правил R1-R{m.group(1)}, фактично R1-R{f['rules']}")
            for m in re.finditer(r"перевірок правила\s+" + NUM, line):
                n = number(m.group(1))
                if n is not None and n != f["rules"]:
                    fails.append(f"D4: {rel}:{i} сказано {n} правил, фактично {f['rules']}")
            if "check_ruleset" not in line and "правила" not in line:
                continue
            for m in re.finditer(r"мутац\w*\s+" + NUM + r"[,.\s]", line):
                n = number(m.group(1))
                if n is not None and n != f["rule_mutations"]:
                    fails.append(f"D4: {rel}:{i} сказано {n} мутацій правила, фактично {f['rule_mutations']}")


def d5_pr_scenarios(f, fails):
    """D5. Кількість сценаріїв приймального прогону pull request актуальна."""
    pat = re.compile(NUM + r"\s+сценар\w*")
    for rel, lines in docs():
        for i, (line, hist) in enumerate(lines, 1):
            if hist or "pr_simulation" not in line:
                continue
            seg = line.split("pr_simulation", 1)[1].split(";")[0]
            for m in pat.finditer(seg):
                n = number(m.group(1))
                if n is not None and n != f["pr_scenarios"]:
                    fails.append(f"D5: {rel}:{i} сказано {n} сценаріїв pull request, фактично {f['pr_scenarios']}")


def d6_i18n_counts(f, fails):
    """D6. Кількість валютних і мовних сценаріїв та їх мутацій актуальна."""
    pat = re.compile(NUM + r"\s+сценарі\w*\s+і\s+" + NUM + r"\s+мутац\w*")
    for rel, lines in docs():
        for i, (line, hist) in enumerate(lines, 1):
            if hist or "check_i18n" not in line:
                continue
            for m in pat.finditer(line):
                s, mut = number(m.group(1)), number(m.group(2))
                if s is not None and s != f["i18n_scenarios"]:
                    fails.append(f"D6: {rel}:{i} сказано {s} сценаріїв i18n, фактично {f['i18n_scenarios']}")
                if mut is not None and mut != f["i18n_mutations"]:
                    fails.append(f"D6: {rel}:{i} сказано {mut} мутацій i18n, фактично {f['i18n_mutations']}")


def d7_ui_group_named(f, fails):
    """D7. Група UI-сценаріїв названа за фактичним діапазоном прогону."""
    texts = "\n".join("\n".join(l for l, _ in lines) for _, lines in docs())
    expect = f"U1-U{f['ui_scenarios']}"
    if expect not in texts:
        fails.append(f"D7: у документах немає групи {expect} (прогін ci/verify_heromode.js)")


# D8: параметри блоку `pull_request` правила гілки та їх опис у документах.
# Формулювання читається посегментно (розділювач «; »), бо той самий параметр
# може бути описаний і як увімкнений, і як вимкнений.
PR_PARAMS = {
    "dismiss_stale_reviews_on_push": r"скидан\w*\s+застарілих схвалень",
    "required_review_thread_resolution": r"закритт\w*\s+коментар\w*",
    "require_code_owner_review": r"схвален\w*\s+власник\w*\s+коду|code owner",
    "require_last_push_approval": r"схвален\w*\s+останнього пуш\w*",
}
# Маркер вимкненого параметра - лише словами: літерал `...: false` у дужках
# цитує саме значення з файла і не мусить вважатися запереченням, інакше
# перевернуте формулювання поруч із ним залишиться невиявленим.
PR_OFF = ("вимкнен", "не вимага")
# Твердження про параметр, якого в блоці немає взагалі: правило гілки не керує
# способами злиття - це окрема настройка репозиторію, і приписувати її правилу
# означає обіцяти захист, якого в файлі немає.
PR_ABSENT = {"allowed_merge_methods": r"способ\w*\s+злиття|merge, squash|squash, rebase"}
# Рядок, який сам говорить «цього в правилі немає», не є хибною обіцянкою.
ABSENT_NEG = ("немає", "не обіця", "не керує")


def d8_pull_request_block(f, fails):
    """D8. Опис блоку pull_request збігається з параметрами правила гілки."""
    params = f["pr_params"]
    seen = set()
    for rel, lines in docs():
        for i, (line, hist) in enumerate(lines, 1):
            if hist or "`pull_request`" not in line:
                continue
            for seg in line.split("; "):
                low = seg.lower()
                for key, pat in PR_PARAMS.items():
                    if not re.search(pat, seg, re.IGNORECASE):
                        continue
                    seen.add(key)
                    claimed = not any(neg in low for neg in PR_OFF)
                    if claimed is not bool(params.get(key)):
                        fails.append(
                            f"D8: {rel}:{i} параметр {key} описаний як "
                            f"{'увімкнений' if claimed else 'вимкнений'}, "
                            f"у правилі {json.dumps(params.get(key))}")
                if any(neg in low for neg in ABSENT_NEG):
                    continue
                for key, pat in PR_ABSENT.items():
                    if re.search(pat, seg, re.IGNORECASE) and key not in params:
                        fails.append(f"D8: {rel}:{i} названо {key}, якого в блоці pull_request правила немає")
            for m in re.finditer(NUM + r"\s+схвален\w*", line):
                n = number(m.group(1))
                want = params.get("required_approving_review_count")
                if n is not None and want is not None and n != want:
                    fails.append(f"D8: {rel}:{i} сказано {n} схвалень, у правилі {want}")
                if n is not None:
                    seen.add("required_approving_review_count")
    if seen:
        for key in params:
            if key not in seen:
                fails.append(f"D8: параметр {key} блоку pull_request не описаний у документах")


CHECKS = [d1_no_stale_groups, d2_contexts_documented, d3_required_count,
          d4_rule_counts, d5_pr_scenarios, d6_i18n_counts, d7_ui_group_named,
          d8_pull_request_block]


def run(root=None):
    global ROOT
    saved = ROOT
    if root:
        ROOT = root
    try:
        f = facts()
        fails = []
        for fn in CHECKS:
            fn(f, fails)
        return f, fails
    finally:
        ROOT = saved


# --- мутації: навмисно зістарена документація -------------------------------

def m_stale_group(root):
    p = os.path.join(root, "ТЗ-рамкове-логістична-біржа.md")
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace("C1-C13, L1-L12", "C1-C9, L1-L6", 1))


def m_required_count(root):
    p = os.path.join(root, "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md")
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace("Обовʼязкових перевірок дванадцять", "Обовʼязкових перевірок три", 1))


def m_rule_range(root):
    p = os.path.join(root, "ci", "README.md")
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace("R1–R14", "R1–R10"))


def m_pr_scenarios(root):
    p = os.path.join(root, "ci", "README.md")
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace("таблиця з девʼятнадцяти сценаріїв",
                                  "таблиця з тринадцяти сценаріїв"))


def m_context_dropped(root):
    p = os.path.join(root, "ci", "ruleset-contract.json")
    obj = json.load(open(p, encoding="utf-8"))
    for r in obj["rules"]:
        if r["type"] == "required_status_checks":
            r["parameters"]["required_status_checks"].append({"context": "Нова перевірка без опису"})
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return True


def m_i18n_counts(root):
    p = os.path.join(root, "ТЗ-логістична-біржа-v2-мови-валюти.md")
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace("25 сценаріїв і 53 мутації", "9 сценаріїв і 20 мутацій", 1))


def m_ui_group(root):
    hit = False
    for rel in DOCS:
        p = os.path.join(root, rel)
        if not os.path.exists(p):
            continue
        t = open(p, encoding="utf-8").read()
        hit = _write(p, t, t.replace("U1-U8", "U1-U6")) or hit
    return hit


def m_merge_methods_claim(root):
    p = os.path.join(root, "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md")
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace("обовʼязкове закриття коментарів",
                                  "обовʼязкове закриття коментарів; дозволені способи злиття — merge, squash, rebase", 1))


def m_pr_param_flipped(root):
    p = os.path.join(root, "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md")
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace("схвалення власника коду вимкнено",
                                  "схвалення власника коду обовʼязкове", 1))


def _write(path, before, after):
    if before == after:
        return False
    open(path, "w", encoding="utf-8").write(after)
    return True


MUTATIONS = [
    ("застаріла назва групи сценаріїв повернулася в ТЗ", m_stale_group),
    ("кількість обовʼязкових перевірок відстала від правила", m_required_count),
    ("діапазон правил R1-RN відстав", m_rule_range),
    ("кількість сценаріїв pull request відстала", m_pr_scenarios),
    ("у правило додано перевірку, якої немає в документах", m_context_dropped),
    ("кількість валютних і мовних сценаріїв відстала", m_i18n_counts),
    ("група UI-сценаріїв названа вужче за прогін", m_ui_group),
    ("правилу приписано керування способами злиття", m_merge_methods_claim),
    ("вимкнений параметр pull_request описаний як обовʼязковий", m_pr_param_flipped),
]

COPY = DOCS + ["ci/ruleset-contract.json", "ci/check_ruleset.py", "ci/pr_simulation.py",
               "ci/verify_heromode.js", "schemas/check_i18n.py"]


def self_test():
    not_caught = []
    for title, mut in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            for rel in COPY:
                src, dst = os.path.join(ROOT, rel), os.path.join(tmp, rel)
                if not os.path.exists(src):
                    continue
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
            if not mut(tmp):
                raise SystemExit(f"мутація не застосувалася: {title}")
            _, fails = run(tmp)
            caught = bool(fails)
            if not caught:
                not_caught.append(title)
            print(f"  {'виявлено' if caught else 'НЕ ВИЯВЛЕНО':12s} {title}")
    print(f"\nмутацій: {len(MUTATIONS)}, виявлено: {len(MUTATIONS) - len(not_caught)}")
    return 1 if not_caught else 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    f, fails = run()
    print(f"обовʼязкових перевірок: {f['required']}, правил прогону: {f['rules']} "
          f"(мутацій {f['rule_mutations']}), сценаріїв pull request: {f['pr_scenarios']}, "
          f"i18n: {f['i18n_scenarios']} сценаріїв і {f['i18n_mutations']} мутацій, "
          f"UI: U1-U{f['ui_scenarios']}")
    for fn in CHECKS:
        name = fn.__doc__.split(".")[0]
        hit = [x for x in fails if x.startswith(name + ":")]
        print(f"{name:3s} {fn.__doc__.split('. ', 1)[1][:80]:82s} {'OK' if not hit else 'ПРОВАЛ'}")
    for x in fails:
        print("  ", x)
    print(f"\nперевірок документації: {len(CHECKS)}, розбіжностей: {len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
