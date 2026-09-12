#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Звіряння живого правила гілки в GitHub із файлом ci/ruleset-contract.json.

Навіщо окремий прогін: check_ruleset.py читає лише файл. Він не побачить, що
в GitHub хтось додав виняток, послабив вимогу схвалення або вилучив перевірку
руками через інтерфейс. Розбіжність між файлом і живим правилом — саме той
випадок, коли репозиторій виглядає захищеним, а насправді ним не є.

Прогін не входить до обовʼязкових перевірок: він потребує токена з правом
читання адміністративних налаштувань, якого немає у звичайного pull request.
Запускати вручну або за розкладом:

    GH_REPO=Dymytrii524/TA GH_RULESET_ID=22136211 python3 ci/check_live_ruleset.py

Код виходу 0 — живе правило збігається з файлом, 1 — є розбіжності,
2 — правило не вдалося прочитати (немає токена, прав або мережі).
Третій випадок свідомо не плутається з першим: «не змогли перевірити»
не дорівнює «все гаразд».
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RS = os.path.join(ROOT, "ci", "ruleset-contract.json")

REPO = os.environ.get("GH_REPO", "Dymytrii524/TA")
RULESET_ID = os.environ.get("GH_RULESET_ID", "22136211")

# Поля правил, які звіряються. Решту ключів GitHub додає сам зі значеннями
# за замовчуванням, і їхня поява не є послабленням захисту.
COMPARED = {
    "pull_request": ["required_approving_review_count", "dismiss_stale_reviews_on_push",
                     "require_code_owner_review", "require_last_push_approval",
                     "required_review_thread_resolution"],
    "required_status_checks": ["strict_required_status_checks_policy"],
}


def live():
    try:
        out = subprocess.run(["gh", "api", f"repos/{REPO}/rulesets/{RULESET_ID}"],
                             capture_output=True, text=True)
    except FileNotFoundError:
        sys.stderr.write("не вдалося прочитати живе правило: у PATH немає gh\n")
        sys.exit(2)
    if out.returncode != 0:
        sys.stderr.write("не вдалося прочитати живе правило: "
                         + (out.stderr.strip() or "невідома помилка") + "\n")
        sys.exit(2)
    return json.loads(out.stdout)


def contexts(obj):
    for r in obj.get("rules", []):
        if r["type"] == "required_status_checks":
            return [c["context"] for c in r["parameters"]["required_status_checks"]]
    return []


def actors(obj):
    return sorted((a.get("actor_type"), a.get("actor_id"), a.get("bypass_mode"))
                  for a in obj.get("bypass_actors", []))


def main():
    want = json.load(open(RS, encoding="utf-8"))
    got = live()
    diffs = []

    if want.get("enforcement") != got.get("enforcement"):
        diffs.append(f"режим: у файлі {want.get('enforcement')!r}, у GitHub {got.get('enforcement')!r}")

    if "bypass_actors" not in want:
        diffs.append("у файлі немає ключа bypass_actors: живі винятки нічим звіряти")
    elif actors(want) != actors(got):
        diffs.append(f"винятки: у файлі {actors(want)}, у GitHub {actors(got)}")

    wc, gc = contexts(want), contexts(got)
    for c in wc:
        if c not in gc:
            diffs.append(f"перевірка не є обовʼязковою в GitHub: {c!r}")
    for c in gc:
        if c not in wc:
            diffs.append(f"перевірка обовʼязкова в GitHub, але відсутня у файлі: {c!r}")

    wr = {r["type"]: r.get("parameters", {}) for r in want.get("rules", [])}
    gr = {r["type"]: r.get("parameters", {}) for r in got.get("rules", [])}
    for t in wr:
        if t not in gr:
            diffs.append(f"правило {t} описане у файлі, але не діє в GitHub")
            continue
        for key in COMPARED.get(t, []):
            if wr[t].get(key) != gr[t].get(key):
                diffs.append(f"{t}.{key}: у файлі {wr[t].get(key)!r}, у GitHub {gr[t].get(key)!r}")
    for t in gr:
        if t not in wr:
            diffs.append(f"правило {t} діє в GitHub, але не описане у файлі")

    print(f"репозиторій: {REPO}, правило: {got.get('name')!r} (id {RULESET_ID})")
    print(f"обовʼязкових перевірок: у файлі {len(wc)}, у GitHub {len(gc)}")
    print(f"винятків: у файлі {len(want.get('bypass_actors', []))}, у GitHub {len(got.get('bypass_actors', []))}")
    if not diffs:
        print("\nживе правило збігається з файлом")
        return 0
    print(f"\nрозбіжностей: {len(diffs)}")
    for d in diffs:
        print("  -", d)
    return 1


if __name__ == "__main__":
    sys.exit(main())
