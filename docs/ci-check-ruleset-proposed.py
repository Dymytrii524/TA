#!/usr/bin/env python3
"""Узгодженість правила захисту гілки з конвеєрами (ТЗ, розділ A.13.4).

Правило гілки посилається на перевірки за іменем. Перейменування job-а,
видалення `needs` або поява job-level `if:` тихо знімає обовʼязковість:
GitHub далі чекає на статус, якого більше немає, або приймає pull request
без прогону. Цей прогін ловить такі розбіжності в CI, а не на продакшені.

Конвеєрів більше одного: контракт схем і proto (`github-actions-contract.yml`)
та контракт бекенду й модуля верифікації (`backend-contract.yml`). Кожен має
власний gate, і кожен gate обовʼязковий у правилі гілки. Конвеєри, що залежать
від зовнішніх джерел (`source-probe.yml`), навмисно не є обовʼязковими —
чужа недоступність не має блокувати вливання коду.

Код виходу 0 — правило узгоджене; 1 — є розбіжність.
"""
import copy
import json
import os
import sys

import yaml

ROOT = os.environ.get("CONTRACT_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RS = os.path.join(ROOT, "ci", "ruleset-contract.json")

# Конвеєр -> імʼя його gate-job-а. Кожен файл із цього переліку вважається
# обовʼязковим: усі його job-и мусять бути названі в правилі гілки.
WORKFLOWS = {
    "github-actions-contract.yml": "contract-gate",
    "backend-contract.yml": "backend-gate",
}

# Групи сценаріїв, які мусять бути названі в правилі гілки (рамкове ТЗ, розділи 13.7 і 14.8).
SCENARIO_GROUPS = {"T16-T27": "приймальні сценарії модуля POST_DRONE",
                   "C1-C13, L1-L12": "валютні та мовні сценарії"}

# Єдиний дозволений виняток із правила гілки: роль Repository admin (actor_id 5).
# Виняток існує з однієї причини: GitHub не дає схвалити власний pull request,
# тому без нього єдиний власник репозиторію не влив би жодної своєї зміни.
# Ролі з меншими правами (write = 3, maintain = 4), додатки й команди тут недопустимі:
# виняток для них знімає обовʼязкові перевірки тихо й назавжди.
ALLOWED_BYPASS = {
    ("RepositoryRole", 5): ("Repository admin", {"always", "pull_request"}),
}

# Документи, у яких шукаються згадки gate-ів і сценаріїв.
DOCS = ["ТЗ-рамкове-логістична-біржа.md",
        "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md",
        "ТЗ-логістична-біржа-v2-мови-валюти.md",
        "sprint-0-backend/ТЗ-бекенд-Спринт-0.md",
        "sprint-0-backend/ТЗ-верифікація-контрагентів.md"]


def load():
    wfs = {}
    for fname in WORKFLOWS:
        path = os.path.join(ROOT, "ci", fname)
        wfs[fname] = yaml.safe_load(open(path, encoding="utf-8"))
    rs = json.load(open(RS, encoding="utf-8"))
    return wfs, rs


def contexts(rs):
    for rule in rs["rules"]:
        if rule["type"] == "required_status_checks":
            return [c["context"] for c in rule["parameters"]["required_status_checks"]]
    raise AssertionError("у правилі немає блоку required_status_checks")


def job_names(wf):
    return {jid: job.get("name", jid) for jid, job in wf["jobs"].items()}


def all_job_names(wfs):
    names = {}
    for fname, wf in wfs.items():
        for jid, name in job_names(wf).items():
            names[name] = (fname, jid)
    return names


def gate_of(wfs, fname):
    """Job-об'єкт gate-а конвеєра за його іменем у WORKFLOWS."""
    gate_name = WORKFLOWS[fname]
    for jid, job in wfs[fname]["jobs"].items():
        if job.get("name", jid) == gate_name:
            return jid, job
    raise AssertionError(f"у конвеєрі {fname} немає gate-job-а {gate_name!r}")


def needs_of(job):
    needs = job.get("needs") or []
    return [needs] if isinstance(needs, str) else list(needs)


def r1_contexts_exist(wfs, rs):
    """R1. Кожна обовʼязкова перевірка відповідає наявному job-у котрогось конвеєра."""
    names = all_job_names(wfs)
    for ctx in contexts(rs):
        assert ctx in names, f"перевірка {ctx!r} не відповідає жодному job-у конвеєрів"


def r2_all_jobs_required(wfs, rs):
    """R2. Кожен job обовʼязкового конвеєра названий у правилі гілки."""
    ctx = set(contexts(rs))
    for fname, wf in wfs.items():
        for jid, name in job_names(wf).items():
            assert name in ctx, (
                f"job {jid!r} конвеєра {fname} (перевірка {name!r}) "
                f"не є обовʼязковим у правилі гілки")


def r3_gate_present(wfs, rs):
    """R3. Gate кожного конвеєра присутній і в конвеєрі, і в правилі."""
    ctx = contexts(rs)
    for fname, gate_name in WORKFLOWS.items():
        gate_of(wfs, fname)
        assert gate_name in ctx, f"{gate_name!r} не є обовʼязковою перевіркою"


def r4_gate_needs_all(wfs, rs):
    """R4. Gate залежить від усіх прогінних job-ів свого конвеєра і виконується завжди."""
    for fname, wf in wfs.items():
        gid, gate = gate_of(wfs, fname)
        needs = needs_of(gate)
        run_jobs = [j for j in wf["jobs"] if j != gid]
        missing = sorted(set(run_jobs) - set(needs))
        assert not missing, f"gate конвеєра {fname} не залежить від job-ів: {missing}"
        assert str(gate.get("if", "")).strip() == "always()", (
            f"gate конвеєра {fname} мусить мати if: always()")


def r5_run_jobs_always_report(wfs, rs):
    """R5. Прогінні job-и не мають job-level `if:` — інакше перевірка може не зʼявитися в pull request."""
    for fname, wf in wfs.items():
        gid, _ = gate_of(wfs, fname)
        for jid, job in wf["jobs"].items():
            if jid == gid:
                continue
            assert "if" not in job, (
                f"job {jid!r} конвеєра {fname} має job-level if: обовʼязкова перевірка "
                f"з такою умовою залишає pull request у стані очікування")


def r6_no_path_filter_on_trigger(wfs, rs):
    """R6. У тригері немає фільтра paths: інакше обовʼязкова перевірка не зʼявиться на частині pull request."""
    for fname, wf in wfs.items():
        on = wf.get("on") or wf.get(True)
        pr = (on or {}).get("pull_request") or {}
        assert "pull_request" in (on or {}), f"конвеєр {fname} не запускається на pull request"
        assert not (isinstance(pr, dict) and ("paths" in pr or "paths-ignore" in pr)), (
            f"фільтр paths у тригері pull_request конвеєра {fname} "
            f"несумісний з обовʼязковою перевіркою")


def r7_scenario_groups_named(wfs, rs):
    """R7. Правило гілки прямо називає обидві групи сценаріїв (T16-T27 і C1-C13, L1-L12)."""
    joined = " | ".join(contexts(rs))
    for token, human in SCENARIO_GROUPS.items():
        assert token in joined, f"у правилі гілки не названо групу сценаріїв {token} ({human})"


def r8_rule_hardening(wfs, rs):
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


def r9_scenario_ids_documented(wfs, rs):
    """R9. Gate-и та ідентифікатори сценаріїв із правила описані в документах ТЗ."""
    both = ""
    for name in DOCS:
        path = os.path.join(ROOT, name)
        assert os.path.exists(path), f"документ {name} відсутній"
        both += open(path, encoding="utf-8").read()
    for token in WORKFLOWS.values():
        assert token in both, f"{token} не згадано в документах ТЗ"
    for group in SCENARIO_GROUPS:
        parts = group.replace(",", " ").split()
        for part in parts:
            a, b = part.split("-")
            letter = a[0]
            lo, hi = int(a[1:]), int(b[1:])
            for n in range(lo, hi + 1):
                assert f"| {letter}{n} |" in both, f"сценарій {letter}{n} із правила гілки не описаний у ТЗ"


def r10_pipeline_does_not_mask_failures(wfs, rs):
    """R10. Кроки з конвеєром `|` виконуються під оболонкою з pipefail, інакше провал маскується."""
    for fname, wf in wfs.items():
        def shell_of(job, step, wf=wf):
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
                    f"крок {step.get('name', script[:40])!r} у job {jid!r} конвеєра {fname} "
                    f"містить конвеєр, а оболонка {shell!r} не має pipefail: код виходу "
                    f"візьметься від останньої команди (наприклад tee), і провал стане невидимим")


def r11_contexts_unique(wfs, rs):
    """R11. У правилі немає повторів перевірок: дублікат маскує втрату справжньої перевірки."""
    ctx = contexts(rs)
    dupes = sorted({c for c in ctx if ctx.count(c) > 1})
    assert not dupes, f"перевірки названі двічі: {dupes}"


def r12_gate_reads_every_result(wfs, rs):
    """R12. Gate звіряє результат кожного job-а, від якого залежить, а не лише перелічує їх у needs."""
    for fname, wf in wfs.items():
        gid, gate = gate_of(wfs, fname)
        script = "\n".join(s.get("run", "") for s in gate.get("steps", []))
        for jid in needs_of(gate):
            assert f"needs.{jid}.result" in script, (
                f"gate конвеєра {fname} не перевіряє результат job-а {jid!r}: "
                f"job у needs, але його провал не змінює код виходу gate-а")


def r13_bypass_explicit(wfs, rs):
    """R13. Список винятків з правила оголошений явно, містить лише дозволені ролі й описаний у ТЗ."""
    assert "bypass_actors" in rs, (
        "у правилі немає ключа bypass_actors: відсутність ключа не дорівнює  «винятків немає» — "
        "живе правило в GitHub може мати винятки, яких немає у файлі, і розбіжність лишиться непоміченою")
    actors = rs["bypass_actors"]
    assert isinstance(actors, list), "bypass_actors мусить бути списком"
    seen = set()
    for actor in actors:
        key = (actor.get("actor_type"), actor.get("actor_id"))
        assert key in ALLOWED_BYPASS, (
            f"виняток {key} не дозволений: будь-хто з цією роллю вливав би в main в обхід "
            f"обовʼязкових перевірок; дозволені лише {sorted(ALLOWED_BYPASS)}")
        assert key not in seen, f"виняток {key} названий двічі"
        seen.add(key)
        human, modes = ALLOWED_BYPASS[key]
        mode = actor.get("bypass_mode")
        assert mode in modes, (
            f"винятку {human} задано режим {mode!r}; дозволені {sorted(modes)}")
    if actors:
        both = ""
        for name in DOCS:
            both += open(os.path.join(ROOT, name), encoding="utf-8").read()
        for actor in actors:
            human = ALLOWED_BYPASS[(actor["actor_type"], actor["actor_id"])][0]
            assert human in both, (
                f"виняток {human} не описаний у документах ТЗ: хто саме й чому може "
                f"обходити правило, мусить бути записано, а не жити лише в налаштуваннях GitHub")


CHECKS = [r1_contexts_exist, r2_all_jobs_required, r3_gate_present, r4_gate_needs_all,
          r5_run_jobs_always_report, r6_no_path_filter_on_trigger, r7_scenario_groups_named,
          r8_rule_hardening, r9_scenario_ids_documented, r10_pipeline_does_not_mask_failures,
          r11_contexts_unique, r12_gate_reads_every_result, r13_bypass_explicit]

IDS = {f.__name__: f.__doc__.split(".")[0] for f in CHECKS}

CONTRACT_WF = "github-actions-contract.yml"
BACKEND_WF = "backend-contract.yml"


def set_ctx(rs, values):
    for rule in rs["rules"]:
        if rule["type"] == "required_status_checks":
            rule["parameters"]["required_status_checks"] = [{"context": v} for v in values]


MUTATIONS = [
    ("R1: у правилі перевірка, якої немає в конвеєрі",
     lambda wfs, rs: set_ctx(rs, contexts(rs) + ["Схема і сценарії T16-T30"])),
    ("R2, R7: job i18n прибрано з правила",
     lambda wfs, rs: set_ctx(rs, [c for c in contexts(rs) if "C1-C13" not in c])),
    ("R1, R2: job i18n перейменовано без оновлення правила",
     lambda wfs, rs: wfs[CONTRACT_WF]["jobs"]["i18n"].update(name="Валютні та мовні сценарії")),
    ("R3: gate контракту прибрано з правила",
     lambda wfs, rs: set_ctx(rs, [c for c in contexts(rs) if c != "contract-gate"])),
    ("R4: gate контракту більше не залежить від i18n",
     lambda wfs, rs: wfs[CONTRACT_WF]["jobs"]["contract-gate"].update(needs=["schema", "proto"])),
    ("R4: у gate контракту прибрано if: always()",
     lambda wfs, rs: wfs[CONTRACT_WF]["jobs"]["contract-gate"].pop("if")),
    ("R5: у прогінного job-а зʼявився job-level if",
     lambda wfs, rs: wfs[CONTRACT_WF]["jobs"]["i18n"].update({"if": "github.event_name == 'pull_request'"})),
    ("R6: у тригері зʼявився фільтр paths",
     lambda wfs, rs: (wfs[CONTRACT_WF].get("on") or wfs[CONTRACT_WF][True]).update(
         pull_request={"paths": ["schemas/**"]})),
    ("R8: правило переведено в режим evaluate", lambda wfs, rs: rs.update(enforcement="evaluate")),
    ("R8: знято вимогу оновленої гілки",
     lambda wfs, rs: [r["parameters"].update(strict_required_status_checks_policy=False)
                      for r in rs["rules"] if r["type"] == "required_status_checks"]),
    ("R8: знято заборону перезапису історії",
     lambda wfs, rs: rs.update(rules=[r for r in rs["rules"] if r["type"] != "non_fast_forward"])),
    ("R8: знято вимогу схвалення",
     lambda wfs, rs: [r["parameters"].update(required_approving_review_count=0)
                      for r in rs["rules"] if r["type"] == "pull_request"]),
    ("R10: у конвеєрі знято pipefail - провал маскується tee",
     lambda wfs, rs: wfs[CONTRACT_WF]["defaults"]["run"].update(shell="bash -e {0}")),
    ("R7: у правилі лишились перевірки без назв груп сценаріїв",
     lambda wfs, rs: set_ctx(rs, ["contract-gate", "Схема", "Валюти"])),
    # Мутації конвеєра бекенду й модуля верифікації.
    ("R2: перевірку інваріантів верифікації прибрано з правила",
     lambda wfs, rs: set_ctx(rs, [c for c in contexts(rs) if c != "Інваріанти верифікації"])),
    ("R1, R2: job контракту верифікації перейменовано без оновлення правила",
     lambda wfs, rs: wfs[BACKEND_WF]["jobs"]["verification-contract"].update(
         name="Контракт верифікації")),
    ("R3: backend-gate прибрано з правила",
     lambda wfs, rs: set_ctx(rs, [c for c in contexts(rs) if c != "backend-gate"])),
    ("R4: backend-gate більше не залежить від інваріантів верифікації",
     lambda wfs, rs: wfs[BACKEND_WF]["jobs"]["backend-gate"].update(
         needs=["backend-contract", "verification-contract", "backend-db"])),
    ("R4: у backend-gate прибрано if: always()",
     lambda wfs, rs: wfs[BACKEND_WF]["jobs"]["backend-gate"].pop("if")),
    ("R5: у job-а інваріантів верифікації зʼявився job-level if",
     lambda wfs, rs: wfs[BACKEND_WF]["jobs"]["verification-db"].update(
         {"if": "github.event_name == 'schedule'"})),
    ("R5: зонд зовнішніх джерел повернуто в обовʼязковий конвеєр",
     lambda wfs, rs: wfs[BACKEND_WF]["jobs"].update(
         sources={"name": "Стан джерел верифікації", "if": "github.event_name == 'schedule'",
                  "runs-on": "ubuntu-latest", "steps": []})),
    ("R6: у тригері конвеєра бекенду зʼявився фільтр paths",
     lambda wfs, rs: (wfs[BACKEND_WF].get("on") or wfs[BACKEND_WF][True]).update(
         pull_request={"paths": ["sprint-0-backend/**"]})),
    ("R10: у конвеєрі бекенду знято pipefail",
     lambda wfs, rs: wfs[BACKEND_WF]["defaults"]["run"].update(shell="bash -e {0}")),
    ("R11: перевірку названо в правилі двічі",
     lambda wfs, rs: set_ctx(rs, contexts(rs) + ["Інваріанти верифікації"])),
    ("R12: backend-gate перелічує job у needs, але не звіряє його результат",
     lambda wfs, rs: wfs[BACKEND_WF]["jobs"]["backend-gate"]["steps"][0].update(
         run='echo "${{ needs.backend-contract.result }}"')),
    ("R13: ключ bypass_actors зник із правила",
     lambda wfs, rs: rs.pop("bypass_actors")),
    ("R13: виняток розширено до ролі write",
     lambda wfs, rs: rs["bypass_actors"].append(
         {"actor_id": 3, "actor_type": "RepositoryRole", "bypass_mode": "always"})),
    ("R13: виняток віддано сторонньому додатку",
     lambda wfs, rs: rs["bypass_actors"].append(
         {"actor_id": 12345, "actor_type": "Integration", "bypass_mode": "always"})),
    ("R13: роль адміністратора підмінено на maintain",
     lambda wfs, rs: rs["bypass_actors"][0].update(actor_id=4)),
    ("R13: той самий виняток названо двічі",
     lambda wfs, rs: rs["bypass_actors"].append(dict(rs["bypass_actors"][0]))),
    ("R13: режим винятку підмінено на невідомий",
     lambda wfs, rs: rs["bypass_actors"][0].update(bypass_mode="never_checked")),
]


def run(wfs, rs):
    out = []
    for fn in CHECKS:
        try:
            fn(wfs, rs)
        except AssertionError as ex:
            out.append(f"{IDS[fn.__name__]}: {ex}")
        except Exception as ex:
            out.append(f"{IDS[fn.__name__]}: {type(ex).__name__}: {ex}")
    return out


def main():
    wfs, rs = load()
    failures = run(wfs, rs)
    print("конвеєри:", ", ".join(f"{f} (gate {g})" for f, g in WORKFLOWS.items()))
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
        w, r = copy.deepcopy(wfs), copy.deepcopy(rs)
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
