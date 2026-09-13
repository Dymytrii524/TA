# Крок «Контракт» у CI

Реалізує розділи A.13.2–A.13.4 додатка A та розділи 13.6 і 14.7 рамкового ТЗ. Прогін не потребує ні бази, ні застосунку.

## Файли

| Файл | Призначення |
|---|---|
| `github-actions-contract.yml` | GitHub Actions: job `schema`, job `i18n`, job `proto` + gate-job `contract-gate` |
| `gitlab-ci-contract.yml` | GitLab CI: ті самі три job через `include: local`; у GitLab обовʼязковість задається не переліком перевірок, а налаштуванням **Pipelines must succeed** для merge request |
| `ruleset-contract.json` | Правило захисту гілки з чотирма обовʼязковими перевірками: `contract-gate`, `Схема і сценарії T16-T27`, `Валютні та мовні сценарії C1-C13, L1-L12`, `Контракт proto модуля SEARCH` |
| `check_ruleset.py` | Прогін R1–R14: узгодженість правила гілки з конвеєрами й дзеркал із робочими файлами, 35 мутацій |
| `check_live_ruleset.py` | Звіряння живого правила в GitHub із файлом `ruleset-contract.json`: перевірки, винятки, вимога схвалення. Потребує `gh` і токена з правом читання налаштувань, тому не входить до обовʼязкових перевірок |
| `proto_mutation.py` | Мутаційний прогін proto-контракту: 12 навмисно зламаних копій, по кожній із перевірок P1–P6 |
| `proto_breaking.py` | Сумісність `transatlas.search.v1` із базовою гілкою (B1–B7), без `buf` |
| `pr_simulation.py` | Приймальний прогін правила на девʼятнадцяти справжніх pull request (не в CI) |
| `../schemas/check_proto_contract.py` | 100 перевірок P1–P6: відповідність proto-контракту нормативній `post-drone.schema.json` |
| `../proto/` | Контракт модуля SEARCH і його `README.md` |
| `../third_party/buf/validate/` | Vendored-оголошення protovalidate; тримає прогони офлайновими |
| `schema_id.py` | Друкує `$id` схеми; окремий файл, щоб не тримати `$id` у рядку `python -c` |
| `../schemas/validate_schema.py` | Перевірка синтаксису схеми окремим кроком; приймає шлях аргументом |
| `../schemas/check_i18n.py` | Сценарії C1–C13 (валюти, курси, ескроу, повний реєстр валют) і L1–L12 (мови, глосарій, реєстр мов, простори імен, ICU) з мутаціями |
| `../schemas/i18n.schema.json` | Схема фікстур `i18n/` |
| `../i18n/` | Фікстури: валюти, локалі, глосарій, каталоги повідомлень, дві угоди, набір маршрутів, `language-roadmap.json`, `currency-roadmap.json`, `namespaces.json` |
| `../ТЗ-логістична-біржа-v2-мови-валюти.md` | Джерело істини для сценаріїв C10–C13 і L7–L12 (розділ 12) |

## Установлення (GitHub)

```bash
mkdir -p .github/workflows
cp ci/github-actions-contract.yml .github/workflows/contract.yml
git add .github/workflows/contract.yml && git commit -m "CI: крок Контракт" && git push
```

Далі — один прогін на основній гілці, щоб перевірка `contract-gate` стала відомою GitHub, і лише після цього:

```bash
gh api --method POST repos/:owner/:repo/rulesets --input ci/ruleset-contract.json
gh api repos/:owner/:repo/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

Перелік обовʼязкових перевірок у створеному правилі:

```bash
gh api repos/:owner/:repo/rulesets/<id> \
  --jq '.rules[] | select(.type=="required_status_checks")
        | .parameters.required_status_checks[].context'
```

> При додаванні job-а `proto` правило захисту гілки потребує одного оновлення з `ci/ruleset-contract.json`: доки перевірка `Контракт proto модуля SEARCH` не відома GitHub, призначення її обовʼязковою тримає pull request у стані очікування. Порядок той самий: злити конвеєр → один прогін на основній гілці → оновити правило.

Перевірка результату на конкретному pull request:

```bash
gh pr checks <номер> --watch
```

## Які перевірки обовʼязкові

Обовʼязкові чотири перевірки:

| Перевірка (`context`) | Job | Роль |
|---|---|---|
| `contract-gate` | `contract-gate` | стале імʼя незалежно від структури конвеєра; явний провал при `cancelled` |
| `Схема і сценарії T16-T27` | `schema` | схема, приклади A.8.4.1, мутації, програмні перевірки |
| `Валютні та мовні сценарії C1-C13, L1-L12` | `i18n` | валютні сценарії C1–C13 і мовні L1–L12 з мутаціями |
| `Контракт proto модуля SEARCH` | `proto` | компіляція `transatlas.search.v1`, перевірки P1–P6, 12 мутацій і сумісність B1–B7 із базовою гілкою |

Всі три прогінні job-и пропускають **кроки**, якщо pull request не торкався ТЗ, схем, `i18n/`, `proto/` чи `ci/`, але самі job-и виконуються завжди: у них немає job-level `if:`, а `actions/checkout` іде без умови. Тому статус завжди `success`, і призначення їх обовʼязковими не блокує pull request, які не змінюють контракт. `contract-gate` виконується з `if: always()`, залежить від усіх трьох прогінних job-ів і трактує `skipped` як успіх, а `failure` і `cancelled` — як провал.

Ціна рішення — привʼязка правила до полів `name:` job-ів. Її перевіряє прогін `python ci/check_ruleset.py` (R1–R14, 35 мутацій): перейменування job-а, вилучення його з правила, зняття `needs`, поява job-level `if:`, фільтр `paths` у тригері, режим `evaluate`, знята вимога схвалення або знятий `pipefail` в оболонці конвеєра падають у CI.

## Ім'я перевірки

`contract-gate` зафіксовано полем `name:` job-а; те саме стосується двох прогінних перевірок. Перейменування job-а розриває звʼязок із правилом гілки, і перевірка тихо перестає бути обовʼязковою — правило чекатиме на статус, якого більше немає.

> Перевірку `i18n` перейменовано з `Валютні та мовні сценарії C1-C9, L1-L6` на `Валютні та мовні сценарії C1-C13, L1-L12`. Після злиття цієї зміни правило захисту гілки в GitHub потрібно один раз оновити з `ci/ruleset-contract.json` (див. розділ «Установлення») і один раз перезапустити конвеєр на відкритих pull request — доки цього не зроблено, правило чекає на стару назву й блокує злиття.

## Розбіжність із живим правилом: кількість схвалень

Файл `ruleset-contract.json` тримає `required_approving_review_count: 1` — прогін `check_ruleset.py` (правило R8) падає, якщо його знизити. Схвалити власний pull request у GitHub неможливо, тому в репозиторії [Dymytrii524/TA](https://github.com/Dymytrii524/TA) вимогу схвалення застосовано разом із єдиним винятком — роллю **Repository admin** у `bypass_actors`. Виняток знімає рев'ю, але не прогін конвеєрів, і має бути вилучений, щойно з'явиться другий розробник із правом рев'ю. Склад списку винятків стежить правило R13, а розбіжність між файлом і живим правилом у GitHub показує окремий прогін `check_live_ruleset.py`.

Це єдина свідома розбіжність між файлом і живим правилом. Решта — активний режим, строгий режим оновленої гілки, заборона видалення й перезапису історії, три обовʼязкові перевірки, скидання застарілих схвалень і вимога закритих тредів — застосована без змін. Щойно в репозиторії з'явиться другий рецензент, значення слід повернути до одного:

```bash
gh api repos/:owner/:repo/rulesets/<id> --jq '.rules[] | select(.type=="pull_request").parameters.required_approving_review_count'
```

## Локальна перевірка перед пушем

```bash
pip install -r schemas/requirements.txt
python schemas/validate_schema.py
python schemas/check_schema.py
python schemas/validate_schema.py schemas/i18n.schema.json
python schemas/check_i18n.py
python ci/check_ruleset.py
python schemas/check_proto_contract.py
python ci/proto_mutation.py
python ci/proto_breaking.py --base origin/main
```

Перед кожною зміною конвеєра або правила гілки — приймальний прогін на справжніх pull request (близько 16 секунд, мережа не потрібна):

```bash
python ci/pr_simulation.py      # таблиця з тринадцяти сценаріїв
python ci/pr_simulation.py -v   # покроковий журнал кожного job-а
```

Прогін створює тимчасовий git-репозиторій із віддаленим `origin`, окрему гілку на сценарій і виконує справжні команди `github-actions-contract.yml`, після чого застосовує `ruleset-contract.json` і повідомляє, чи злиття було б дозволене. Код виходу 1 — хоча б один сценарій розійшовся з очікуванням. У CI прогін не вбудований: він виконує кроки workflow, тому крок у тому ж workflow дав би рекурсію.

Статичний аналіз workflow (потрібні `actionlint` і `shellcheck`):

```bash
actionlint -shellcheck "$(command -v shellcheck)" .github/workflows/contract.yml
```

## Оболонка кроків

У конвеєрі задано `defaults: run: shell: bash -euo pipefail {0}`. Це не косметика: типова оболонка GitHub Actions — `bash -e` без `pipefail`, тому крок `python schemas/check_schema.py | tee contract-report.txt` повертав би код виходу `tee`, тобто нуль, і провал перевірки не блокував би злиття. Дефект виявлено справжніми pull request у репозиторії [Dymytrii524/TA](https://github.com/Dymytrii524/TA): шість несумісних змін отримали статус `CLEAN`. У GitLab-конвеєрі ту саму роль виконує `set -o pipefail` перед кроками з `tee`. Правило R10 прогону `check_ruleset.py` не дає повернути цю помилку.
