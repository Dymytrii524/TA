# PR #15: виправлення F01–F03 та регресійні перевірки

Дата: 22.09.2026. Обсяг: тільки три P1 з рев’ю Web3 Sprint 0, тести й супровідні API/SQL/CI/ABI зміни; merge, deployment у зовнішні мережі та зміна branch protection не входять до цього коміту.

Це історичний звіт P1-коміту `5067b7a`; його логи збережені без переписування. Актуальний ланцюжок із міграцією 004 та повторні перевірки описані у `docs/p2-fixes.pplx.md`.

## Виправлення

| ID | Зміна | Регресійний доказ |
|---|---|---|
| F01 | `create` приймає nonce; ID обчислюється контрактом із payer, chain та contract domain | Інша адреса створює/скасовує угоду з тим самим nonce, але не займає ID жертви; replay того самого payer після settlement відхиляється |
| F02 | Незмінні binding identity; односпрямоване відкликання; повний wallet/network/commercial snapshot у deal_terms | Зміни agreement/FX/company/price у deals не змінюють snapshot; переписування binding і frozen row відхиляється; новий create intent із відкликаним binding блокується |
| F03 | Projection звіряється із snapshot та парою finalized Funded/StateChanged тієї самої транзакції; funding evidence immutable | Помилкові principal/addresses/hash/deadlines/id, missing/wrong event fields, unfinalized/cross-tx/nonadjacent події, DELETE/TRUNCATE відхиляються; валідний replay ідемпотентний |

Нові файли: `db/003_p1_integrity.sql`, `test/P1Regression.t.sol`, `tests/db-p1.test.mjs`, `tests/p1-fixture.mjs`, `tools/escrow-identity.mjs`. Чинний Web3 workflow запускає нову SQL-suite, усі Solidity suites та сьому негативну мутацію ID namespace.

## Фактичні локальні результати

| Перевірка | Результат | Лог |
|---|---|---|
| Foundry CI profile | 42 passed, 0 failed, 0 skipped; включає 4 нові P1 tests | `artifacts/p1/foundry.log` |
| Негативні мутації Solidity | 7/7 виявлено; мутанти компілюються і падають на призначених тестах | `artifacts/p1/mutations.log` |
| SQL baseline 001/002 | 28 passed, без регресій | `artifacts/p1/db-baseline.log` |
| SQL актуальний 001/002/003 | 42 P1 checks passed | `artifacts/p1/db-p1.log` |
| OpenAPI | 5 positive / 10 negative; nonce та ID не можна підмінити через IntentRequest | `artifacts/p1/api.log` |
| Локальна EVM | 16 checks; реальні ABI logs і finalized-block getDeal → SQL snapshot | `artifacts/p1/integration.log` |
| Offline Amoy config | 5 passed, без RPC/broadcast | `artifacts/p1/amoy-config.log` |

Fuzz має 2048 прикладів; кожен із трьох invariants має 256 runs × 128 depth. Нові тести мають звичайну regression-семантику: PASS означає очікуваний захист, на відміну від попередніх review PoC, де PASS означав відтворення проблеми.

## Сумісність і порядок застосування

Перший аргумент `create(bytes32,...)` тепер означає nonce, не готовий ID. Типи аргументів і selector не змінилися, тому старий calldata не можна використовувати з новою версією контракту; helper, tests, ABI та API description узгоджені з новою семантикою.

Міграції слід застосовувати в порядку 001 → 002 → 003 до першого freeze/ingestion. Міграція 003 бере блокування і fail-closed відхиляє наявні terms/projections/events: потрібен окремий перевірений backfill, а не очищення БД або реконструкція історії з поточних mutable records.

`terms_hash` готує довірений сервіс за канонічним encoding. SQL не виконує Keccak і не перевіряє Ethereum receipts криптографічно; SQL guards звіряють зафіксований hash та всі projection values з decoded event, а локальний EVM regression додатково перевіряє encoding і `getDeal` на блоці funding.

## Межі та невирішені зауваження

Це не незалежний аудит і не готовий production settlement. Runtime grants, tenant authorization, production RPC/finality verification, concurrency на окремому PostgreSQL та повний event-to-ledger writer ще не реалізовані.

F04 (cross-chain intent_transactions), F05 (wallet withdrawal model), F06 (finite fiat/FX), F07 (окремий review deadline) та додаткові C01–C04 не закриті цим комітом. Перевірка chain при freeze/create intent не є повним виправленням F04.

Відкликання binding блокує підготовку нового create intent, але не скасовує раніше підписану транзакцію on-chain. SQL-суперкористувач або власник, який змінює DDL/вимикає triggers, лишається поза захистом DML-обмежень.

Попередній `docs/acceptance-report.pplx.md` та старі logs описують початкову версію. Поточні докази цього виправлення зберігаються окремо в `artifacts/p1/`; ABI в `artifacts/TransAtlasEscrow.abi.json` регенеровано для нового контракту.
