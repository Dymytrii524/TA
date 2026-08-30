#!/usr/bin/env python3
"""Узгодженість правила захисту гілки з конвеєром (ТЗ, розділ A.13.4).

Правило гілки посилається на перевірки за іменем. Перейменування job-а,
видалення `needs` або поява job-level `if:` тихо знімає обовʼязковість:
GitHub далі чекає на статус, якого більше немає, або приймає pull request
без прогону. Цей прогін ловить такі розбіжності в CI, а не на продакшені.

Код виходу 0 — правило узгоджене; 1 — є розбіжність.
"""
import copy
import json
import os
import sys

import yaml

ROOT = os.environ.get("CONTRACT_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(ROOT, "ci", "github-actions-contract.yml")
RS = os.path.join(ROOT, "ci", "ruleset-contract.json")

GATE = "contract-gate"
# Групи сценаріїв, які мусять бути названі в правилі гілки (рамкове ТЗ, розділи 13.7 і 14.8).
SCENARIO_GROUPS = {"T16-T27": "приймальні сценарії модуля POST_DRONE",
                   "C1-C9, L1-L6": "валютні та мовні сценарії"}


def load():
    wf = yaml.safe_load(open(WF, encoding="utf-8"))
    rs = json.load(open(RS, encoding="utf-8"))
    return wf, rs


def contexts(rs):
    for rule in rs["rules"]:
        if rule["type"] == "required_status_checks":
            return [c["context"] for c in rule["parameters"]["required_status_checks"]]
    raise AssertionError("у правилі немає блоку required_status_checks")


def job_names(wf):
    return {jid: job.get("name", jid) for jid, job in wf["jobs"].items()}


def r1_contexts_exist(wf, rs):
    """R1. Кожна обовʼязкова перевірка відповідає наявному job-у конвеєра."""
    names = set(job_names(wf).values())
    for ctx in contexts(rs):
        assert ctx in names, f"перевірка {ctx!r} не відповідає жодному job-у конвеєра"


def r2_all_jobs_required(wf, rs):
    """R2. Кожен прогінний job конвеєра названий у правилі гілки."""
    names = job_names(wf)
    ctx = set(contexts(rs))
    for jid, name in names.items():
        assert name in ctx, f"job {jid!r} (перевірка {name!r}) не є обовʼязковим у правилі гілки"


def r3_gate_present(wf, rs):
    """R3. Gate-перевірка присутня і в конвеєрі, і в правилі."""
    names = job_names(wf)
    assert names.get(GATE) == GATE, f"job {GATE!r} відсутній або перейменований"
    assert GATE in contexts(rs), f"{GATE!r} не є обовʼязковою перевіркою"


def r4_gate_needs_all(wf, rs):
    """R4. Gate залежить від усіх прогінних job-ів і виконується завжди."""
    gate = wf["jobs"][GATE]
    needs = gate.get("needs") or []
    needs = [needs] if isinstance(needs, str) else list(needs)
    run_jobs = [j for j in wf["jobs"] if j != GATE]
    missing = sorted(set(run_jobs) - set(needs))
    assert not missing, f"gate не залежить від job-ів: {missing}"
    assert str(gate.get("if", "")).strip() == "always()", "gate мусить мати if: always()"


def r5_run_jobs_always_report(wf, rs):
    """R5. Прогінні job-и не мають job-level `if:` — інакше перевірка може не зʼявитися в pull request."""
    for jid, job in wf["jobs"].items():
        if jid == GATE:
            continue
        assert "if" not in job, (
            f"job {jid!r} має job-level if: обовʼязкова перевірка з такою умовою "
            f"залишає pull request у стані очікування")


def r6_no_path_filter_on_trigger(wf, rs):
    """R6. У тригері немає фільтра paths: інакше обовʼязкова перевірка не зʼявиться на частині pull request."""
    on = wf.get("on") or wf.get(True)
    pr = (on or {}).get("pull_request") or {}
    assert not (isinstance(pr, dict) and ("paths" in pr or "paths-ignore" in pr)), (
        "фільтр paths у тригері pull_request несумісний з обовʼязковою перевіркою")


def r7_scenario_groups_named(wf, rs):
    """R7. Правило гілки прямо називає обидві групи сценаріїв (T16-T27 і C1-C9, L1-L6)."""
    joined = " | ".join(contexts(rs))
    for token, human in SCENARIO_GROUPS.items():
        assert token in joined, f"у правилі гілки не названо групу сценаріїв {token} ({human})"


def r8_rule_hardening(wf, rs):
    """R8. Правило активне, вимагає оновленої гілки, pull request і забороняє видалення й перезапис історії."""
    assert rs.get("enforcement") == "active", "правило неактивне"
    types = {r["type"] for r in rs["rules"]}
    for t in ("deletion", "non_fast_forward", "pull_request", "required_status_checks"):
        assert t in types, f"у правилі немає блоку {t}"
    for rule in rs["rules"]:
        if rule["type"] == "required_status_checks":
            assert rule["parameters"].get("strict_required_status_checks_policy") is True, (
                "strict_required_status_checks_policy мусить бути true")
        if rule["type"] == "pull_request":
            assert rule["parameters"].get("required_approving_review_count", 0) >= 1, (
                "правило мусить вимагати щонайменше одне схвалення")


def r9_scenario_ids_documented(wf, rs):
    """R9. Ідентифікатори сценаріїв із правила описані в документах ТЗ."""
    fw = open(os.path.join(ROOT, "ТЗ-рамкове-логістична-біржа.md"), encoding="utf-8").read()
    an = open(os.path.join(ROOT, "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md"), encoding="utf-8").read()
    both = fw + an
    for token in ("contract-gate",):
        assert token in both, f"{token} не згадано в документах ТЗ"
    for group in SCENARIO_GROUPS:
        parts = group.replace(",", " ").split()
        for part in parts:
            a, b = part.split("-")
            letter = a[0]
            lo, hi = int(a[1:]), int(b[1:])
            for n in range(lo, hi + 1):
                assert f"| {letter}{n} |" in both, f"сценарій {letter}{n} із правила гілки не описаний у ТЗ"


def r10_pipeline_does_not_mask_failures(wf, rs):
    """R10. Кроки з конвеєром `|` виконуються під оболонкою з pipefail, інакше провал маскується."""
    def shell_of(job, step):
        return (step.get("shell")
                or job.get("defaults", {}).get("run", {}).get("shell")
                or wf.get("defaults", {}).get("run", {}).get("shell")
                or "bash -e {0}")
    for jid, job in wf["jobs"].items():
        for step in job.get("steps", []):
            script = step.get("run")
            if not script or "|" not in script.replace("||", ""):
                continue
            shell = shell_of(job, step)
            assert "pipefail" in shell, (
                f"крок {step.get('name', script[:40])!r} у job {jid!r} містить конвеєр, "
                f"а оболонка {shell!r} не має pipefail: код виходу візьметься від останньої "
                f"команди (наприклад tee), і провал прогону стане невидимим")


CHECKS = [r1_contexts_exist, r2_all_jobs_required, r3_gate_present, r4_gate_needs_all,
          r5_run_jobs_always_report, r6_no_path_filter_on_trigger, r7_scenario_groups_named,
          r8_rule_hardening, r9_scenario_ids_documented, r10_pipeline_does_not_mask_failures]

IDS = {f.__name__: f.__doc__.split(".")[0] for f in CHECKS}


def set_ctx(rs, values):
    for rule in rs["rules"]:
        if rule["type"] == "required_status_checks":
            rule["parameters"]["required_status_checks"] = [{"context": v} for v in values]


MUTATIONS = [
    ("R1: у правилі перевірка, якої немає в конвеєрі",
     lambda wf, rs: set_ctx(rs, contexts(rs) + ["Схема і сценарії T16-T30"])),
    ("R2, R7: job i18n прибрано з правила",
     lambda wf, rs: set_ctx(rs, [c for c in contexts(rs) if "C1-C9" not in c])),
    ("R1, R2: job i18n перейменовано без оновлення правила",
     lambda wf, rs: wf["jobs"]["i18n"].update(name="Валютні та мовні сценарії")),
    ("R3: gate прибрано з правила", lambda wf, rs: set_ctx(rs, [c for c in contexts(rs) if c != GATE])),
    ("R4: gate більше не залежить від i18n", lambda wf, rs: wf["jobs"][GATE].update(needs=["schema"])),
    ("R4: у gate прибрано if: always()", lambda wf, rs: wf["jobs"][GATE].pop("if")),
    ("R5: у прогінного job-а зʼявився job-level if",
     lambda wf, rs: wf["jobs"]["i18n"].update({"if": "github.event_name == 'pull_request'"})),
    ("R6: у тригері зʼявився фільтр paths",
     lambda wf, rs: (wf.get("on") or wf[True]).update(pull_request={"paths": ["schemas/**"]})),
    ("R8: правило переведено в режим evaluate", lambda wf, rs: rs.update(enforcement="evaluate")),
    ("R8: знято вимогу оновленої гілки",
     lambda wf, rs: [r["parameters"].update(strict_required_status_checks_policy=False)
                     for r in rs["rules"] if r["type"] == "required_status_checks"]),
    ("R8: знято заборону перезапису історії",
     lambda wf, rs: rs.update(rules=[r for r in rs["rules"] if r["type"] != "non_fast_forward"])),
    ("R8: знято вимогу схвалення",
     lambda wf, rs: [r["parameters"].update(required_approving_review_count=0)
                     for r in rs["rules"] if r["type"] == "pull_request"]),
    ("R10: у конвеєрі знято pipefail - провал маскується tee",
     lambda wf, rs: wf["defaults"]["run"].update(shell="bash -e {0}")),
    ("R7: у правилі лишились перевірки без назв груп сценаріїв",
     lambda wf, rs: set_ctx(rs, [GATE, "Схема", "Валюти"])),
]


def run(wf, rs):
    out = []
    for fn in CHECKS:
        try:
            fn(wf, rs)
        except AssertionError as ex:
            out.append(f"{IDS[fn.__name__]}: {ex}")
        except Exception as ex:
            out.append(f"{IDS[fn.__name__]}: {type(ex).__name__}: {ex}")
    return out


def main():
    wf, rs = load()
    failures = run(wf, rs)
    print("обовʼязкові перевірки в правилі:", ", ".join(contexts(rs)))
    for fn in CHECKS:
        name = IDS[fn.__name__]
        hit = [f for f in failures if f.startswith(name + ":")]
        print(f"{name:3s} {fn.__doc__.split('. ', 1)[1][:80]:82s} {'OK' if not hit else 'ПРОВАЛ'}")
    for f in failures:
        print("  ", f)

    print("\nмутаційне тестування:")
    not_caught = []
    for title, mut in MUTATIONS:
        w, r = copy.deepcopy(wf), copy.deepcopy(rs)
        mut(w, r)
        caught = bool(run(w, r))
        if not caught:
            not_caught.append(title)
        print(f"  {'відхилено' if caught else 'НЕ ВИЯВЛЕНО':12s} {title}")

    total = len(MUTATIONS)
    print(f"\nперевірок правила: {len(CHECKS)}, провалів: {len(failures)}")
    print(f"мутацій: {total}, виявлено: {total - len(not_caught)}, не виявлено: {len(not_caught)}, "
          f"покриття: {round(100 * (total - len(not_caught)) / total)}%")
    return 1 if failures or not_caught else 0


if __name__ == "__main__":
    sys.exit(main())
