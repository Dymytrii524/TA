"""Фільтри змін конвеєра «Контракт» покривають усе, що читають їхні прогони.

Прогінні job-и contract.yml пропускають кроки, коли pull request не торкається
файлів із фільтра. Це безпечно лише за умови, що фільтр містить кожен файл,
який job реально читає. Інакше pull request, що змінює лише такий файл,
отримує зелену обовʼязкову перевірку без жодного прогону. Саме так
відбувалося з index.html, docs/, ТЗ у sprint-0-backend/, .github/workflows/
і third_party/: їх читали D9-D12, R14 і компіляція proto, а фільтр їх не мав.

Множина читаних файлів не записується вручну, а виводиться з конвеєра:
скрипти з кроків `python X` / `node X`, шляхи в самих кроках і рядкові
літерали шляхів у цих скриптах (зокрема os.path.join("a", "b")),
зіставлені з `git ls-files`.

F1. Фільтр кожного job-а GitHub покриває файли, які читає job, і сам конвеєр.
F2. rules:changes відповідного job-а GitLab покриває ті самі файли.
F3. GitHub і GitLab пропускають прогін на тих самих файлах (паритет).
F4. Кожен фільтр GitHub читає імена з core.quotepath=false.

  python ci/check_change_filters.py [корінь]
  python ci/check_change_filters.py --self-test
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WORKFLOW = ".github/workflows/contract.yml"
GITLAB = "ci/gitlab-ci-contract.yml"
SELF = "ci/check_change_filters.py"
# job GitHub -> job GitLab
JOBS = {"schema": "contract", "i18n": "i18n", "proto": "proto", "ui": "ui"}
# Шляхи, які прогін створює сам, а не читає з дерева.
IGNORE = {"contract-report.txt", "i18n-report.txt", "proto-report.txt", "ui-report.txt"}


def tracked(root):
    out = subprocess.run(["git", "-c", "core.quotepath=false", "ls-files"], cwd=root,
                         capture_output=True, text=True, check=True).stdout
    files = [f for f in out.split("\n") if f and os.path.exists(os.path.join(root, f))]
    dirs = {os.path.dirname(f) for f in files}
    for d in list(dirs):
        while d:
            dirs.add(d)
            d = os.path.dirname(d)
    dirs.discard("")
    return files, dirs


def literals(text):
    """Рядкові літерали та склеєні os.path.join(...) з тексту скрипта або кроку."""
    # Частини os.path.join - не самостійні шляхи: join(ROOT, "sprint-0-backend", "ci")
    # читає sprint-0-backend/ci, а не весь sprint-0-backend/. Тому join-и склеюємо
    # і вирізаємо з тексту до загального пошуку літералів.
    out = set()
    for args in re.findall(r"os\.path\.join\(([^()]*)\)", text):
        parts = re.findall(r"""["']([^"'\n]+)["']""", args)
        if parts:
            out.add("/".join(parts))
    text = re.sub(r"os\.path\.join\(([^()]*)\)", "", text)
    out |= set(re.findall(r"""["']([^"'\n]{2,160})["']""", text))
    out |= set(re.findall(r"(?<![\w/.-])((?:[\w.-]+/)+[\w.*-]+)", text))
    return out


def reads(root, job, files, dirs):
    """Файли дерева, які читає job: скрипти, їхні літерали й шляхи з кроків."""
    wf = yaml.safe_load(open(os.path.join(root, WORKFLOW), encoding="utf-8"))
    steps = [s["run"] for s in wf["jobs"][job]["steps"] if "run" in s and s.get("id") != "changed"]
    text = "\n".join(steps)
    scripts = set(re.findall(r"(?:python3?|node)\s+([\w./-]+\.(?:py|js))", text))
    pool = literals(text)
    for s in scripts:
        p = os.path.join(root, s)
        # Літерали цього прогону - дані мутацій, а не файли, які він читає.
        if os.path.exists(p) and s != SELF:
            pool |= literals(open(p, encoding="utf-8").read())
    pool |= scripts
    got = set()
    for lit in pool:
        lit = lit.strip().lstrip("./")
        if not lit or lit in IGNORE:
            continue
        if "*" in lit:
            rx = re.compile("^" + re.escape(lit).replace(r"\*", "[^/]*") + "$")
            got |= {f for f in files if rx.match(f)}
        elif lit in files:
            got.add(lit)
        elif lit.rstrip("/") in dirs:
            d = lit.rstrip("/") + "/"
            got |= {f for f in files if f.startswith(d)}
    return got


def gh_filter(root, job):
    wf = open(os.path.join(root, WORKFLOW), encoding="utf-8").read()
    data = yaml.safe_load(wf)
    step = next(s for s in data["jobs"][job]["steps"] if s.get("id") == "changed")
    m = re.search(r"grep -Eq '([^']+)'", step["run"])
    return step["run"], re.compile(m.group(1))


def gl_changes(root, job):
    data = yaml.safe_load(open(os.path.join(root, GITLAB), encoding="utf-8"))
    for rule in data[job].get("rules", []):
        if "changes" in rule:
            return rule["changes"]
    return []


def gl_covers(globs, path):
    for g in globs:
        if g == path:
            return True
        if g.endswith("/**/*") and path.startswith(g[:-4]):
            return True
    return False


def run(root):
    files, dirs = tracked(root)
    fails = []
    for job, gl_job in JOBS.items():
        need = reads(root, job, files, dirs) | {WORKFLOW}
        text, rx = gh_filter(root, job)
        globs = gl_changes(root, gl_job)
        for f in sorted(need):
            if not rx.match(f):
                fails.append(f"F1: {job}: фільтр GitHub не містить {f}, який читає прогін")
        for f in sorted(need - {WORKFLOW}) + [GITLAB]:
            if not gl_covers(globs, f):
                fails.append(f"F2: {gl_job}: rules:changes GitLab не містить {f}")
        # GitHub додатково слухає .github/workflows/ - це власний файл конвеєра,
        # якого GitLab не виконує, тож розбіжністю це не є.
        gh_set = {f for f in files if rx.match(f) and not f.startswith(".github/workflows/")}
        gl_set = {f for f in files if gl_covers(globs, f)}
        for f in sorted(gh_set - gl_set):
            fails.append(f"F3: {job}: {f} запускає прогін у GitHub, але не в GitLab")
        for f in sorted(gl_set - gh_set):
            fails.append(f"F3: {job}: {f} запускає прогін у GitLab, але не в GitHub")
        if "diff --name-only" in text and "core.quotepath=false" not in text:
            fails.append(f"F4: {job}: фільтр читає імена без core.quotepath=false")
    return fails


# --- самоперевірка ---------------------------------------------------------

def _sub(path, old, new):
    t = open(path, encoding="utf-8").read()
    if old not in t:
        return False
    open(path, "w", encoding="utf-8").write(t.replace(old, new, 1))
    return True


MUTATIONS = [
    ("зі schema-фільтра зникла головна сторінка", WORKFLOW,
     "|index\\.html|docs/|", "|docs/|"),
    ("зі schema-фільтра зникли дзеркала docs/", WORKFLOW,
     "|index\\.html|docs/|", "|index\\.html|"),
    ("зі schema-фільтра зникли скрипти бекенду", WORKFLOW,
     "sprint-0-backend/(ci/|requirements", "sprint-0-backend/(requirements"),
    ("зі schema-фільтра зник сам конвеєр", WORKFLOW,
     "|ТЗ-)|\\.github/workflows/|schemas/", "|ТЗ-)|schemas/"),
    ("з proto-фільтра зник third_party/", WORKFLOW, "|third_party/", ""),
    ("фільтр ui читає імена без quotepath", WORKFLOW,
     "if git -c core.quotepath=false diff --name-only \"$base\"...HEAD | grep -Eq '^(index",
     "if git diff --name-only \"$base\"...HEAD | grep -Eq '^(index"),
    ("GitLab не слухає third_party/", GITLAB, '        - "third_party/**/*"\n', ""),
    ("GitLab слухає зайвий каталог", GITLAB,
     '        - "i18n/**/*"\n', '        - "i18n/**/*"\n        - "server/**/*"\n'),
]


def self_test():
    missed = []
    for title, rel, old, new in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "clone", "-q", "--no-hardlinks", ROOT, tmp], check=True)
            for extra in (WORKFLOW, GITLAB, "ci/check_change_filters.py"):
                shutil.copy2(os.path.join(ROOT, extra), os.path.join(tmp, extra))
            if run(tmp):
                raise SystemExit(f"копія дерева не чиста до мутації: {run(tmp)[:3]}")
            if not _sub(os.path.join(tmp, rel), old, new):
                raise SystemExit(f"мутація не застосувалася: {title}")
            caught = bool(run(tmp))
            print(f"  {'виявлено' if caught else 'НЕ ВИЯВЛЕНО':12s} {title}")
            if not caught:
                missed.append(title)
    print(f"\nмутацій: {len(MUTATIONS)}, виявлено: {len(MUTATIONS) - len(missed)}")
    return 1 if missed else 0


def main():
    global ROOT
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if args:
        ROOT = os.path.abspath(args[0])
    if "--self-test" in sys.argv:
        return self_test()
    files, dirs = tracked(ROOT)
    for job in JOBS:
        need = sorted(reads(ROOT, job, files, dirs))
        tops = sorted({f.split("/")[0] + ("/" if "/" in f else "") for f in need})
        print(f"{job:7s} читає {len(need):4d} файлів: {', '.join(tops)}")
    fails = run(ROOT)
    for x in fails:
        print("  ", x)
    print(f"\njob-ів: {len(JOBS)}, розбіжностей фільтрів: {len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
