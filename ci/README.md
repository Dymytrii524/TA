# Крок «Контракт» у CI

Реалізує розділи A.13.2–A.13.4 додатка A та розділи 13.6 і 14.7 рамкового ТЗ. Прогін не потребує ні бази, ні застосунку.

## Файли

| Файл | Призначення |
|---|---|
| `github-actions-contract.yml` | GitHub Actions: job `schema`, job `i18n` + gate-job `contract-gate` |
| `gitlab-ci-contract.yml` | GitLab CI: ті самі два job через `include: local`; у GitLab обовʼязковість задається не переліком перевірок, а налаштуванням **Pipelines must succeed** для merge request |
| `ruleset-contract.json` | Правило захисту гілки з трьома обовʼязковими перевірками: `contract-gate`, `Схема і сценарії T16-T27`, `Валютні та мовні сценарії C1-C9, L1-L6` |
| `check_ruleset.py` | Прогін R1–R9: узгодженість правила гілки з конвеєром, з мутаціями |
| `pr_simulation.py` | Приймальний прогін правила на одинадцяти справжніх pull request (не в CI) |
| `schema_id.py` | Друкує `$id` схеми; окремий файл, щоб не тримати `$id` у рядку `python -c` |
| `../schemas/validate_schema.py` | Перевірка синтаксису схеми окремим кроком; приймає шлях аргументом |
| `../schemas/check_i18n.py` | Сценарії C1–C9 (валюти, курси, ескроу) і L1–L6 (мови, глосарій) з мутаціями |
| `../schemas/i18n.schema.json` | Схема фікстур `i18n/` |
| `../i18n/` | Фікстури: валюти, локалі, глосарій, каталоги повідомлень, дві угоди, набір маршрутів |

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

Перевірка результату на конкретному pull request:

```bash
gh pr checks <номер> --watch
```

## Які перевірки обовʼязкові

Обовʼязкові три перевірки:

| Перевірка (`context`) | Job | Роль |
|---|---|---|
| `contract-gate` | `contract-gate` | стале імʼя незалежно від структури конвеєра; явний провал при `cancelled` |
| `Схема і сценарії T16-T27` | `schema` | схема, приклади A.8.4.1, мутації, програмні перевірки |
| `Валютні та мовні сценарії C1-C9, L1-L6` | `i18n` | валютні сценарії C1–C9 і мовні L1–L6 з мутаціями |

Job `schema` і job `i18n` пропускають **кроки**, якщо pull request не торкався ТЗ, схем, `i18n/` чи `ci/`, але самі job-и виконуються завжди: у них немає job-level `if:`, а `actions/checkout` іде без умови. Тому статус завжди `success`, і призначення їх обовʼязковими не блокує pull request, які не змінюють контракт. `contract-gate` виконується з `if: always()`, залежить від обох job і трактує `skipped` як успіх, а `failure` і `cancelled` — як провал.

Ціна рішення — привʼязка правила до полів `name:` job-ів. Її перевіряє прогін `python ci/check_ruleset.py` (R1–R9, 13 мутацій): перейменування job-а, вилучення його з правила, зняття `needs`, поява job-level `if:`, фільтр `paths` у тригері, режим `evaluate` або знята вимога схвалення падають у CI.

## Ім'я перевірки

`contract-gate` зафіксовано полем `name:` job-а; те саме стосується двох прогінних перевірок. Перейменування job-а розриває звʼязок із правилом гілки, і перевірка тихо перестає бути обовʼязковою — правило чекатиме на статус, якого більше немає.

## Локальна перевірка перед пушем

```bash
pip install -r schemas/requirements.txt
python schemas/validate_schema.py
python schemas/check_schema.py
python schemas/validate_schema.py schemas/i18n.schema.json
python schemas/check_i18n.py
python ci/check_ruleset.py
```

Перед кожною зміною конвеєра або правила гілки — приймальний прогін на справжніх pull request (близько 16 секунд, мережа не потрібна):

```bash
python ci/pr_simulation.py      # таблиця з одинадцяти сценаріїв
python ci/pr_simulation.py -v   # покроковий журнал кожного job-а
```

Прогін створює тимчасовий git-репозиторій із віддаленим `origin`, окрему гілку на сценарій і виконує справжні команди `github-actions-contract.yml`, після чого застосовує `ruleset-contract.json` і повідомляє, чи злиття було б дозволене. Код виходу 1 — хоча б один сценарій розійшовся з очікуванням. У CI прогін не вбудований: він виконує кроки workflow, тому крок у тому ж workflow дав би рекурсію.

Статичний аналіз workflow (потрібні `actionlint` і `shellcheck`):

```bash
actionlint -shellcheck "$(command -v shellcheck)" .github/workflows/contract.yml
```
