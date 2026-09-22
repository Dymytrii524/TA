# PR #15: F04 і перевірка скінченності F06

Дата: 22.09.2026. Окремий патч поверх `5067b7a` на прохання власника: тільки F04, скінченність F06, регресійні тести й additive CI; без merge, зовнішнього deployment або зміни правил гілок ([PR #15](https://github.com/Dymytrii524/TA/pull/15)).

Історичний звіт P2-коміту `fdc8d58`; статус C03 нижче стосується саме цього зрізу. Наступне виправлення формату calldata й актуальні C03 регресії описані у `docs/c03-fix.pplx.md`.

## Реалізація

- **F04:** нова міграція `db/004_p2_chain_and_finite.sql` додає UNIQUE `(id,chain_id)` до intents і composite FK `(intent_id,chain_id)` для intent_transactions. NO ACTION захищає також UPDATE батьківського intent; FK до chain_transactions і заборона приписати транзакцію двом intents збережені.
- **F06:** іменовані CHECK constraints відхиляють numeric NaN, Infinity та -Infinity у price_amount/fx_rate. Окремі constraints валідовують immutable commercial snapshots, навіть коли mutable deal уже виправлено.
- **Freeze:** чинний trigger копіює реальні дані deal, а не довільний JSON від caller. Після 004 невалідні значення не можна записати в deal; скопійований snapshot додатково перевіряється constraint.
- **Міграція:** порядок 001→002→003→004. 004 допускає коректні populated дані, але при некоректних links або числах повністю відкочується без переписування даних і без часткового встановлення constraints.
- **CI:** `tests/db-p2.test.mjs` включений до SQL/API step чинного Web3 workflow та його копії в пакеті. Shared fixture за замовчуванням застосовує 004, тому P1 і локальний EVM→SQL bridge перевіряють оновлену схему.

## Регресії F04/F06

Нова suite містить 42 перевірки, включно з INSERT/UPDATE між 31337 і 80002 в обох напрямках, parent intent mutation, replacement/replay та чинною унікальністю транзакцій. Для price/FX перевірено INSERT/UPDATE NaN/±Infinity, збереження позитивності й двох десяткових знаків price, точність finite FX, freeze та historical migration rollback.

Історичні fixtures будуються на реальній схемі 003 без вимкнення triggers. Зокрема перевіряється frozen NaN/Infinity після виправлення mutable deal: міграція повинна відхилити старий snapshot, а не оголосити історію коректною.

## Фактичні локальні результати

Логи нижче записано новими запусками для цього патча, не скопійовано з попереднього рев’ю. Усі команди запускалися з кореня `web3-sprint-0`; це не незалежний аудит.

| Набір | Результат | Лог |
|---|---|---|
| Нові SQL P2 | 42 passed | `artifacts/p2/db-p2.log` |
| SQL P1 на 001–004 | 42 passed | `artifacts/p2/db-p1.log` |
| Legacy SQL baseline 001/002 | 28 passed | `artifacts/p2/db-baseline.log` |
| Solidity unit/fuzz/invariants | 42 passed, 0 failed/skipped; CI profile | `artifacts/p2/foundry.log` |
| Solidity negative mutations | 7/7 виявлено | `artifacts/p2/mutations.log` |
| API schema/fixtures/parity | 5 positive, 10 negative | `artifacts/p2/api.log` |
| Offline Amoy configuration | 5 passed, без RPC/broadcast | `artifacts/p2/amoy-config.log` |
| Local Anvil integration | 16 passed, funding bridge на схемі 001–004 | `artifacts/p2/local-evm.log` |

Local Anvil deployment mock-контрактів є лише ізольованим тестом на loopback, не розгортанням Trans-Atlas або контракту у зовнішній мережі. Логи локальних tx/address не є посиланнями на Amoy.

## Межі виправлення

- **F06 scope:** скінченність виправлена на рівні БД та snapshot; нові бізнес-максимуми, FX precision/scale і production HTTP-validation не реалізовані. Чинні правила позитивності й price precision не послаблено; округлення/конвертацію не додано.
- **Незмінений код контракту:** Solidity, ABI, termsHash, OpenAPI та lockfiles цей патч не змінює.
- **Невирішені ризики:** F05 wallet-level accounting, F07 inspection window та C03 odd-length calldata залишаються відкритими. Нового production indexer, HTTP-сервера чи механізму незалежної перевірки receipts немає.
- **Середовище тестів:** SQL перевірено PGlite; multi-session concurrency на окремому PostgreSQL-сервері та production grants цим запуском не доведені.
- **Історія:** 004 не виправляє невалідні дані автоматично й не скасовує stop-guard 003. Потрібні backup, maintenance window і погоджений план remediation за помилки міграції.
- **CI:** локальні результати не підміняють remote CI. Після push слід перевіряти конкретний SHA у PR, без merge або deployment.
