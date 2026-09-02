#!/usr/bin/env python3
"""Наскрізний прогін правила гілки на справжніх pull request (ТЗ, розділ A.13.4).

Що робить: створює справжній git-репозиторій із віддаленим origin, для кожного
сценарію окрему гілку з комітом, після чого виконує **власні команди workflow**
`ci/github-actions-contract.yml` — включно з кроком відбору змінених файлів,
який порівнює гілку з базовою через `git diff`. Далі обчислює висновок кожного
job-а за семантикою GitHub Actions (крок із невиконаною умовою `if` — skipped),
запускає gate-job і застосовує правило `ci/ruleset-contract.json`: злиття
дозволене лише тоді, коли кожна обовʼязкова перевірка має статус success,
skipped або neutral.

Мережа не потрібна: `pip` підмінено заглушкою, залежності вже в середовищі.
Код виходу 0 — усі сценарії дали очікуваний результат.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import yaml

ROOT = os.environ.get("CONTRACT_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COPY = ["ci", "schemas", "i18n", "ТЗ-рамкове-логістична-біржа.md",
        "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md",
        "ТЗ-логістична-біржа-v2-мови-валюти.md"]
BASE = "main"
SUCCESS, SKIPPED, FAILURE = "success", "skipped", "failure"


def sh(cmd, cwd, env=None, check=True):
    r = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), env=env,
                       capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"{cmd}\n{r.stdout}\n{r.stderr}")
    return r


# --- сценарії: кожен змінює робочу копію гілки -----------------------------

def s_untouched(d):
    open(os.path.join(d, "NOTES.md"), "w", encoding="utf-8").write("нотатки, контракту не торкаються\n")


def s_valid_i18n(d):
    for lang, text in (("uk", "Знайти зворотні рейси"), ("en", "Find return trips"),
                       ("pl", "Znajdź powrotne rejsy"), ("de", "Rückfahrten finden")):
        p = os.path.join(d, "i18n", "messages", f"{lang}.json")
        obj = json.load(open(p, encoding="utf-8"))
        obj["search.reverse"] = text
        json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def s_currency_dropped(d):
    p = os.path.join(d, "i18n", "currencies.json")
    obj = json.load(open(p, encoding="utf-8"))
    obj["currencies"] = [c for c in obj["currencies"] if c["code"] != "GBP"]
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def s_language_key_lost(d):
    p = os.path.join(d, "i18n", "messages", "de.json")
    obj = json.load(open(p, encoding="utf-8"))
    obj.pop("escrow.locked")
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def s_glossary_translated(d):
    p = os.path.join(d, "i18n", "messages", "uk.json")
    obj = json.load(open(p, encoding="utf-8"))
    obj["terms.incoterms"] = "Умови постачання Інкотермс"
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def s_stale_rate_no_notice(d):
    p = os.path.join(d, "i18n", "deal-stale-rate.json")
    obj = json.load(open(p, encoding="utf-8"))
    obj["fx"].pop("display_stale_notice")
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def s_base_currency_drift(d):
    p = os.path.join(d, "i18n", "currencies.json")
    obj = json.load(open(p, encoding="utf-8"))
    obj["base"] = "USD"
    for c in obj["currencies"]:
        c["roles"] = [r for r in c["roles"] if r != "base"]
        if c["code"] == "USD":
            c["roles"].append("base")
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def s_contract_enum_narrowed(d):
    p = os.path.join(d, "schemas", "post-drone.schema.json")
    lines = open(p, encoding="utf-8").read().splitlines(keepends=True)
    out, dropped = [], False
    for i, line in enumerate(lines):
        if not dropped and line.strip() == '"timeout"':
            out[-1] = out[-1].replace(",\n", "\n")  # прибрати кому з попереднього елемента
            dropped = True
            continue
        out.append(line)
    assert dropped, "мутація PR-8 не застосувалася"
    t = "".join(out)
    open(p, "w", encoding="utf-8").write(t)


def s_job_renamed(d):
    p = os.path.join(d, "ci", "github-actions-contract.yml")
    t = open(p, encoding="utf-8").read().replace(
        "    name: Валютні та мовні сценарії C1-C13, L1-L12", "    name: i18n-checks")
    open(p, "w", encoding="utf-8").write(t)


def s_gate_needs_dropped(d):
    p = os.path.join(d, "ci", "github-actions-contract.yml")
    t = open(p, encoding="utf-8").read().replace("    needs: [schema, i18n]", "    needs: [schema]")
    open(p, "w", encoding="utf-8").write(t)


def s_rule_weakened(d):
    p = os.path.join(d, "ci", "ruleset-contract.json")
    obj = json.load(open(p, encoding="utf-8"))
    for r in obj["rules"]:
        if r["type"] == "required_status_checks":
            r["parameters"]["required_status_checks"] = [
                c for c in r["parameters"]["required_status_checks"] if "C1-C13" not in c["context"]]
    json.dump(obj, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


# сценарій, очікувані висновки job-ів (None — не перевіряємо), очікуване злиття
SCENARIOS = [
    ("PR-1 без дотику до контракту", s_untouched, {"schema": SUCCESS, "i18n": SUCCESS}, True,
     "кроки пропускаються, обидві перевірки звітують success"),
    ("PR-2 сумісна правка мов (новий ключ у 4 каталогах)", s_valid_i18n, {"schema": SUCCESS, "i18n": SUCCESS}, True,
     "L1 і L2 проходять, злиття вільне"),
    ("PR-3 валюту GBP вилучено з конфігурації", s_currency_dropped, {"i18n": FAILURE}, False,
     "C1: конфігурація розійшлася з таблицею 13.1"),
    ("PR-4 у німецькому каталозі втрачено ключ", s_language_key_lost, {"i18n": FAILURE}, False,
     "L1: різні набори ключів"),
    ("PR-5 термін глосарію перекладено", s_glossary_translated, {"i18n": FAILURE}, False,
     "L3: Incoterms замінено"),
    ("PR-6 застарілий курс без позначки", s_stale_rate_no_notice, {"i18n": FAILURE}, False,
     "C7: відхилено самою схемою фікстур"),
    ("PR-7 базову валюту змінено лише в конфігурації", s_base_currency_drift, {"i18n": FAILURE}, False,
     "C2: розбіжність із розділом A.5"),
    ("PR-8 звужено перерахування reason у схемі", s_contract_enum_narrowed, {"schema": FAILURE}, False,
     "несумісна правка контракту"),
    ("PR-9 job перейменовано без оновлення правила", s_job_renamed, {"schema": FAILURE}, False,
     "R1, R2: правило гілки чекало б на статус, якого немає"),
    ("PR-10 gate більше не залежить від i18n", s_gate_needs_dropped, {"schema": FAILURE}, False,
     "R4: втрачено залежність gate-а"),
    ("PR-11 перевірку i18n вилучено з правила", s_rule_weakened, {"schema": FAILURE}, False,
     "R2, R7: правило перестало називати групу C1-C13, L1-L12"),
]


# --- підготовка репозиторію ------------------------------------------------

def prepare(tmp):
    origin = os.path.join(tmp, "origin.git")
    work = os.path.join(tmp, "work")
    sh(["git", "init", "--bare", "-b", BASE, origin], tmp)
    os.makedirs(work)
    sh(["git", "init", "-b", BASE, work], tmp)
    for name in ("user.email", "user.name"):
        sh(["git", "config", name, "ci@example.net" if "email" in name else "ci"], work)
    for item in COPY:
        src = os.path.join(ROOT, item)
        dst = os.path.join(work, item)
        shutil.copytree(src, dst) if os.path.isdir(src) else shutil.copy2(src, dst)
    sh(["git", "add", "-A"], work)
    sh(["git", "commit", "-qm", "base"], work)
    sh(["git", "remote", "add", "origin", origin], work)
    sh(["git", "push", "-q", "origin", BASE], work)
    return work


def make_branch(work, name, mutate):
    # прибрати артефакти звітів, які залишили кроки попереднього прогону
    sh(["git", "checkout", "-q", "--", "."], work)
    sh(["git", "clean", "-qfd"], work)
    sh(["git", "checkout", "-q", BASE], work)
    sh(["git", "checkout", "-qb", name], work)
    mutate(work)
    sh(["git", "add", "-A"], work)
    sh(["git", "commit", "-qm", name], work)
    sh(["git", "push", "-q", "origin", name], work)
    sh(["git", "fetch", "-q", "origin", BASE], work)


def shims(tmp):
    """python -> python3, pip -> заглушка (залежності вже встановлені, мережі немає)."""
    b = os.path.join(tmp, "bin")
    os.makedirs(b, exist_ok=True)
    open(os.path.join(b, "python"), "w").write("#!/bin/sh\nexec python3 \"$@\"\n")
    open(os.path.join(b, "pip"), "w").write('#!/bin/sh\necho "pip: пропущено (залежності в середовищі)"\n')
    for f in ("python", "pip"):
        os.chmod(os.path.join(b, f), 0o755)
    return b


def subst(text, branch):
    text = text.replace("${{ github.event_name }}", "pull_request")
    text = text.replace("${{ github.base_ref }}", BASE)
    text = text.replace("${{ github.head_ref }}", branch)
    return text


def cond_true(expr, outputs, prev_failed):
    """Спрощений, але точний для наших умов обчислювач `if:`."""
    if expr is None:
        return not prev_failed
    e = str(expr).strip()
    always = "always()" in e
    if prev_failed and not always:
        return False
    m = re.search(r"steps\.changed\.outputs\.run == '(\w+)'", e)
    if m:
        return outputs.get("run") == m.group(1)
    if "github.event_name == 'pull_request'" in e:
        return True
    return True


def shell_argv(wf, job, step):
    """Оболонка кроку за правилами GitHub Actions.

    Типове значення для Linux-runner-а — `bash -e {0}`, БЕЗ pipefail: код виходу
    конвеєра `python ... | tee file` дорівнює коду `tee`. Прогін мусить
    відтворювати саме цю семантику, інакше маскування провалу лишиться
    непоміченим (див. розділ A.13.4 ТЗ).
    """
    spec = (step.get("shell")
            or job.get("defaults", {}).get("run", {}).get("shell")
            or wf.get("defaults", {}).get("run", {}).get("shell")
            or "bash -e {0}")
    flags = [tok for tok in spec.split() if tok != "{0}"]
    return flags + ["-c"]


def run_job(work, binpath, wf, job, branch, logs, side):
    env = dict(os.environ)
    env["PATH"] = binpath + os.pathsep + env["PATH"]
    outputs, failed = {}, False
    gh_out = os.path.join(side, "gh_output")
    gh_sum = os.path.join(side, "gh_summary")
    open(gh_out, "w").close()
    open(gh_sum, "w").close()
    env["GITHUB_OUTPUT"] = gh_out
    env["GITHUB_STEP_SUMMARY"] = gh_sum
    for step in job["steps"]:
        label = step.get("name") or step.get("uses")
        if not cond_true(step.get("if"), outputs, failed):
            logs.append(f"      skipped: {label}")
            continue
        if "uses" in step:  # checkout, setup-python, upload-artifact — інфраструктура runner-а
            logs.append(f"      ok:      {label} (крок runner-а)")
            continue
        argv = shell_argv(wf, job, step) + [subst(step["run"], branch)]
        r = sh(argv, work, env=env, check=False)
        for line in (r.stdout + r.stderr).strip().splitlines():
            if line.strip():
                logs.append(f"        | {line}")
        with open(gh_out, encoding="utf-8") as fh:
            for line in fh:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    outputs[k] = v
        if r.returncode:
            failed = True
            logs.append(f"      FAILED:  {label} (код {r.returncode})")
        else:
            logs.append(f"      ok:      {label}")
    # У GitHub Actions job, усі кроки якого пропущені кроковою умовою `if`,
    # все одно завершується висновком success — саме тому прогінні job-и
    # безпечно призначати обовʼязковими перевірками.
    return FAILURE if failed else SUCCESS


def run_gate(work, binpath, wf, results, logs):
    env = dict(os.environ)
    env["PATH"] = binpath + os.pathsep + env["PATH"]
    step = wf["jobs"]["contract-gate"]["steps"][0]
    argv = shell_argv(wf, wf["jobs"]["contract-gate"], step)
    script = step["run"]
    for jid, res in results.items():
        script = script.replace("${{ needs.%s.result }}" % jid, res)
    r = sh(argv + [script], work, env=env, check=False)
    for line in (r.stdout + r.stderr).strip().splitlines():
        logs.append(f"        | {line}")
    return SUCCESS if r.returncode == 0 else FAILURE


def merge_allowed(work, statuses, logs):
    """Застосування правила гілки: кожна обовʼязкова перевірка мусить бути success або skipped."""
    rs = json.load(open(os.path.join(work, "ci", "ruleset-contract.json"), encoding="utf-8"))
    wf = yaml.safe_load(open(os.path.join(work, "ci", "github-actions-contract.yml"), encoding="utf-8"))
    names = {job.get("name", jid): jid for jid, job in wf["jobs"].items()}
    contexts = [c["context"] for r in rs["rules"] if r["type"] == "required_status_checks"
                for c in r["parameters"]["required_status_checks"]]
    ok = True
    for ctx in contexts:
        jid = names.get(ctx)
        if jid is None:
            logs.append(f"      перевірка {ctx!r}: статусу немає (job відсутній) — pull request в очікуванні")
            ok = False
            continue
        st = statuses.get(jid, "pending")
        logs.append(f"      перевірка {ctx!r}: {st}")
        if st not in (SUCCESS, SKIPPED):
            ok = False
    return ok


def main():
    verbose = "-v" in sys.argv
    tmp = tempfile.mkdtemp(prefix="prsim-")
    try:
        work = prepare(tmp)
        binpath = shims(tmp)
        rows, bad = [], 0
        for idx, (title, mutate, expect_jobs, expect_merge, why) in enumerate(SCENARIOS, 1):
            branch = f"pr-{idx}"
            make_branch(work, branch, mutate)
            wf = yaml.safe_load(open(os.path.join(work, "ci", "github-actions-contract.yml"), encoding="utf-8"))
            logs = [f"  {title} (гілка {branch})"]
            statuses = {}
            for jid in [j for j in wf["jobs"] if j != "contract-gate"]:
                logs.append(f"    job {jid}:")
                statuses[jid] = run_job(work, binpath, wf, wf["jobs"][jid], branch, logs, tmp)
                logs.append(f"    -> {jid}: {statuses[jid]}")
            logs.append("    job contract-gate:")
            statuses["contract-gate"] = run_gate(work, binpath, wf, statuses, logs)
            logs.append(f"    -> contract-gate: {statuses['contract-gate']}")
            logs.append("    правило гілки:")
            allowed = merge_allowed(work, statuses, logs)

            ok = allowed == expect_merge and all(
                statuses.get(j) == exp for j, exp in expect_jobs.items())
            bad += 0 if ok else 1
            rows.append((title, statuses, allowed, expect_merge, ok, why))
            if verbose or not ok:
                print("\n".join(logs))
        print()
        print(f"{'Сценарій':52s} {'schema':9s} {'i18n':9s} {'gate':9s} {'злиття':10s} {'очікувано':10s} Вердикт")
        for title, st, allowed, exp, ok, why in rows:
            print(f"{title[:52]:52s} {st.get('schema',''):9s} {st.get('i18n',''):9s} "
                  f"{st.get('contract-gate',''):9s} {'дозволене' if allowed else 'блоковане':10s} "
                  f"{'дозволене' if exp else 'блоковане':10s} {'OK' if ok else 'РОЗБІЖНІСТЬ'}")
            print(f"{'':52s} причина: {why}")
        print(f"\nсценаріїв pull request: {len(SCENARIOS)}, розбіжностей з очікуванням: {bad}")
        return 1 if bad else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
