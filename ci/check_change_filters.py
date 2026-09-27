#!/usr/bin/env python3
"""Фільтри змін конвеєра мусять покривати те, що читають самі прогони
(ТЗ, розділ A.13.4: обовʼязкова перевірка не має зависати в очікуванні
статусу, якого job ніколи не виставить).

Кожен обовʼязковий job економить час, пропускаючи прогін, коли pull
request чи merge request не торкнувся шляхів, які його скрипти читають:
крок «Чи торкнувся PR контракту» в .github/workflows/contract.yml (bash
`grep -Eq '^(...)'`) і `rules: changes:` у ci/gitlab-ci-contract.yml. Якщо
фільтр відстає від скрипта - правка файлу, який скрипт справді читає,
тихо пропускає прогін: job звітує «run=false» (GitHub) чи не запускається
взагалі (GitLab), і статус лишається зеленим, хоч перевірку не виконано.

Джерело істини для «що читає job» - реальне дерево git (`git ls-files`),
а не опис фільтра: для проєктів (proto/, third_party/, schemas/, i18n/,
sprint-0-backend/ci/), де фільтр - це не один прапор-каталог, а перелік
із кількох частин, кожен реальний файл перевіряється окремо, бо саме
такий перелік і ламається по одному пункту при рефакторингу. Виняток -
docs/: перелік навмисно вручну куруємо, а не `git ls-files docs/`, бо там
лежать і docs/chronicle/*.html - знімки хроніки проєкту, яких жоден
скрипт контракту не читає (на них посилається лише README цієї бази
знань). Дерево читається з реального кореня репозиторію завжди, навіть
під час --self-test: мутація нижче міняє лише текст фільтра в тимчасовій
копії двох YAML-файлів, а не файлову структуру, тож дерево, яке ці
фільтри мають покривати, лишається тим самим.

Обидва механізми перевіряються однаково - тестовим шляхом, а не текстом
патерна, бо один пише `sprint-0-backend/(ci/|requirements\\.txt|ТЗ-)`
одним регулярним виразом, а інший - трьома окремими рядками `changes:`.

Коди виходу: 0 - усі фільтри покривають свої шляхи, 1 - є прогалина.
`--self-test` прибирає по одному шляху з кожного механізму і перевіряє,
що прогалина виявляється.
"""
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

GH_WORKFLOW = ".github/workflows/contract.yml"
GL_MIRROR = "ci/gitlab-ci-contract.yml"

# Ім'я job-а в GitHub -> ім'я того самого job-а в GitLab-дзеркалі. "schema"
# в GitHub звітує як "Схема і сценарії T16-T27", а в GitLab той самий job
# називається "contract" (ci/gitlab-ci-contract.yml, коментар відповідності).
GH_TO_GL_JOB = {"schema": "contract", "i18n": "i18n", "proto": "proto", "ui": "ui"}

# docs/*, які реально читають схема job-а: check_doc_counts.py читає DOCS
# (ТЗ і ci/README.md, поза цим списком) і D12-звіряє ці п'ять дзеркал.
DOCS_RELEVANT = [
    "docs/backend-sprint0-spec.md",
    "docs/ci-backend-contract-workflow.yml",
    "docs/ci-check-ruleset-proposed.py",
    "docs/ci-ruleset-contract-proposed.json",
    "docs/stack-decision-spec.md",
    "docs/verification-spec.md",
    "docs/verification-sprint1-spec.md",
]


def git_files(prefix):
    """Реально відстежені git-файли під prefix, з реального кореня репозиторію."""
    out = subprocess.run(["git", "-C", ROOT, "ls-files", prefix],
                         capture_output=True, text=True, check=True)
    return [line for line in out.stdout.splitlines() if line]


def job_paths():
    """Шляхи, які реально читає кожен job - з дерева git, не з опису фільтра."""
    return {
        "schema": (
            ["ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md",
             "ТЗ-рамкове-логістична-біржа.md",
             "ТЗ-логістична-біржа-v2-мови-валюти.md",
             "index.html"]
            + DOCS_RELEVANT
            + git_files("proto/")
            + git_files("sprint-0-backend/ci/")
            + ["sprint-0-backend/requirements.txt",
               "sprint-0-backend/ТЗ-бекенд-Спринт-0.md",
               "sprint-0-backend/ТЗ-верифікація-контрагентів.md"]
            + git_files("schemas/")
            + git_files("i18n/")
            + [".github/workflows/contract.yml", "ci/check_ruleset.py"]
        ),
        "i18n": (
            ["ТЗ-рамкове-логістична-біржа.md",
             "ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md",
             "ТЗ-логістична-біржа-v2-мови-валюти.md"]
            + git_files("i18n/")
            + git_files("schemas/")
            + ["ci/check_ruleset.py"]
        ),
        "proto": (
            ["ТЗ-алгоритм-пошуку-вантажів-і-маршрутів.md",
             "ТЗ-рамкове-логістична-біржа.md"]
            + git_files("proto/")
            + git_files("third_party/")
            + git_files("schemas/")
            + ["ci/proto_mutation.py", "ci/check_contract_text.py", "ci/proto_breaking.py"]
        ),
        "ui": ["index.html", ".github/workflows/contract.yml", "ci/verify_heromode.js"],
    }


# --- читання двох конвеєрів --------------------------------------------------

def gh_workflow_doc(ci_root):
    return yaml.safe_load(open(os.path.join(ci_root, GH_WORKFLOW), encoding="utf-8").read())


def gl_mirror_doc(ci_root):
    return yaml.safe_load(open(os.path.join(ci_root, GL_MIRROR), encoding="utf-8").read())


def gh_pattern(doc, job_name):
    """Регулярка з кроку `changed` job-а job_name; None, якщо кроку/job-а немає."""
    steps = ((doc.get("jobs") or {}).get(job_name) or {}).get("steps") or []
    for step in steps:
        if step.get("id") != "changed":
            continue
        run = step.get("run") or ""
        m = re.search(r"grep -Eq '\^\((.+?)\)'", run)
        return m.group(1) if m else None
    return None


def gl_changes(doc, job_name):
    """Список `changes:` з першого MR-правила job-а; None, якщо job-а немає."""
    job = (doc or {}).get(job_name)
    if not job:
        return None
    for rule in job.get("rules") or []:
        if "changes" in rule:
            return rule["changes"]
    return None


def gitlab_matches(pattern, path):
    if pattern.endswith("/**/*"):
        return path.startswith(pattern[:-5] + "/")
    return path == pattern


def facts(ci_root):
    return {"gh": gh_workflow_doc(ci_root), "gl": gl_mirror_doc(ci_root), "paths": job_paths()}


# --- перевірки ---------------------------------------------------------------

def c1_github_filters_cover_paths(f, fails):
    """C1. Регулярка кроку `changed` в GitHub спрацьовує на кожен шлях, який job читає."""
    for gh_job, paths in f["paths"].items():
        pattern = gh_pattern(f["gh"], gh_job)
        if pattern is None:
            fails.append(f"C1: .github/workflows/contract.yml: job {gh_job} без кроку `changed` або без grep-фільтра")
            continue
        try:
            rx = re.compile("^(" + pattern + ")")
        except re.error as e:
            fails.append(f"C1: job {gh_job}: регулярка не компілюється: {e}")
            continue
        for path in paths:
            if not rx.search(path):
                fails.append(f"C1: .github/workflows/contract.yml: job {gh_job}: фільтр не покриває {path!r}")


def c2_gitlab_filters_cover_paths(f, fails):
    """C2. Список `changes:` у GitLab-дзеркалі покриває кожен шлях, який job читає."""
    for gh_job, paths in f["paths"].items():
        gl_job = GH_TO_GL_JOB[gh_job]
        changes = gl_changes(f["gl"], gl_job)
        if changes is None:
            fails.append(f"C2: ci/gitlab-ci-contract.yml: job {gl_job} без `changes:` у MR-правилі")
            continue
        for path in paths:
            if not any(gitlab_matches(p, path) for p in changes):
                fails.append(f"C2: ci/gitlab-ci-contract.yml: job {gl_job}: `changes:` не покриває {path!r}")


CHECKS = [c1_github_filters_cover_paths, c2_gitlab_filters_cover_paths]


def run(ci_root=None):
    ci_root = ci_root or ROOT
    f = facts(ci_root)
    fails = []
    for fn in CHECKS:
        fn(f, fails)
    return fails


# --- мутації: навмисно звужений фільтр --------------------------------------

def _write(path, before, after):
    if before == after:
        return False
    open(path, "w", encoding="utf-8").write(after)
    return True


def m_github_drop_index_html(root):
    p = os.path.join(root, GH_WORKFLOW)
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace(
        r"ТЗ-логістична-біржа-v2-мови-валюти\.md|index\.html|docs/|proto/",
        r"ТЗ-логістична-біржа-v2-мови-валюти\.md|docs/|proto/", 1))


def m_github_drop_third_party(root):
    p = os.path.join(root, GH_WORKFLOW)
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace(r"proto/|third_party/|schemas/", r"proto/|schemas/", 1))


def m_github_ui_drop_workflows(root):
    p = os.path.join(root, GH_WORKFLOW)
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace(
        r"'^(index\.html|ci/|\.github/workflows/)'",
        r"'^(index\.html|ci/)'", 1))


def m_gitlab_drop_sprint0_ci(root):
    p = os.path.join(root, GL_MIRROR)
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace('        - "sprint-0-backend/ci/**/*"\n', "", 1))


def m_gitlab_drop_third_party(root):
    p = os.path.join(root, GL_MIRROR)
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace(
        '        - "proto/**/*"\n        - "third_party/**/*"\n',
        '        - "proto/**/*"\n', 1))


def m_gitlab_drop_ui_ci(root):
    p = os.path.join(root, GL_MIRROR)
    t = open(p, encoding="utf-8").read()
    return _write(p, t, t.replace(
        '        - "index.html"\n        - "ci/**/*"\n        - ".github/workflows/**/*"\n',
        '        - "index.html"\n        - ".github/workflows/**/*"\n', 1))


MUTATIONS = [
    ("GitHub: schema-фільтр забув index.html", m_github_drop_index_html),
    ("GitHub: proto-фільтр забув third_party/", m_github_drop_third_party),
    ("GitHub: ui-фільтр забув .github/workflows/", m_github_ui_drop_workflows),
    ("GitLab: contract-фільтр забув sprint-0-backend/ci/", m_gitlab_drop_sprint0_ci),
    ("GitLab: proto-фільтр забув third_party/", m_gitlab_drop_third_party),
    ("GitLab: ui-фільтр забув ci/", m_gitlab_drop_ui_ci),
]

COPY = [GH_WORKFLOW, GL_MIRROR]


def self_test():
    not_caught = []
    for title, mut in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            for rel in COPY:
                src, dst = os.path.join(ROOT, rel), os.path.join(tmp, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)
            if not mut(tmp):
                raise SystemExit(f"мутація не застосувалася: {title}")
            fails = run(tmp)
            caught = bool(fails)
            if not caught:
                not_caught.append(title)
            print(f"  {'виявлено' if caught else 'НЕ ВИЯВЛЕНО':12s} {title}")
    print(f"\nмутацій: {len(MUTATIONS)}, виявлено: {len(MUTATIONS) - len(not_caught)}")
    return 1 if not_caught else 0


def main():
    if "--self-test" in sys.argv:
        return self_test()
    fails = run()
    for x in fails:
        print("  ", x)
    print(f"\nперевірок фільтрів змін: {len(CHECKS)}, розбіжностей: {len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
