# Web3 Sprint 0: звіт фактичної перевірки

Версія 0.1.0, 22.09.2026. Перевірки виконані локально на створеному пакеті; це не аудит, не звіт GitHub Actions і не підтвердження розгортання Amoy.

## Підсумок

| Перевірка | Фактичний результат | Доказ у пакеті |
|---|---|---|
| Foundry CI-profile | 38 passed, 0 failed, 0 skipped | `artifacts/foundry-ci.log` |
| Unit/fuzz suite | 35 тестів, з них один fuzz із 2048 прикладами | `artifacts/foundry-ci.log` |
| Stateful invariants | 3 invariants, кожен 256 runs × 128 depth = 32 768 calls, 0 reverts | `artifacts/foundry-ci.log` |
| Negative mutation | 6/6 помилок виявлено, кожен запуск повернув exit=1 | `artifacts/mutation-tests.log` |
| SQL | 28 passed, 0 failed | `artifacts/sql-tests.log` |
| API | OpenAPI 3.1 valid, 5 positive/8 negative fixtures, state/action parity | `artifacts/api-tests.log` |
| Local RPC/EVM | 14 passed, реальні локальні deployment/transactions | `artifacts/local-evm.log` |
| Offline Amoy config | 5 passed, без RPC і broadcast | `artifacts/amoy-config-tests.log` |
| Допоміжне coverage | Контракт: 99.20% lines, 93.07% statements, 58.82% branches, 100% functions | `artifacts/coverage.log` |
| npm audit | 0 відомих вразливостей у фінальному dependency tree | `artifacts/npm-audit.json` |

Не слід складати fuzz runs, invariant calls, SQL assertions і тести у єдине маркетингове число «тестів». Це різні одиниці покриття та різні рівні перевірки.

## Foundry і фінансові інваріанти

Команда приймання: `FOUNDRY_PROFILE=ci node tools/foundry.mjs forge test -vv`. Основний контракт компілювався solc 0.8.30 з optimizer=200 та EVM paris; тестовий seed зафіксовано як `0x20260922`.

- **Conservation:** `totalDeposited = totalWithdrawn + locked + totalClaimable`.
- **Solvency:** token balance не менший за locked + totalClaimable; donation не створює зобов’язання.
- **Deal sum:** сума депозитів незавершених угод відповідає locked; сума claims тестових учасників відповідає totalClaimable.
- **Невакуумність:** handler має початковий життєвий цикл та незалежні ghost-лічильники; інваріанти не проходять лише через порожній контракт.
- **Границі:** acceptBy, releaseAt, arbiter cutoff перевіряються з exact-boundary сценаріями.
- **Виплати:** pause/blacklist failure зберігає claim, повторне settlement/withdraw відхиляється.
- **Reentrancy:** callback тест перевіряє конкретний селектор ReentrancyGuardReentrantCall, а не будь-який revert.

Stateful тестування не перебирає всі можливі стани та не є формальним доказом. Тут не перевірялися всі можливі ERC20-реалізації або інтеграція з реальним Circle-контрактом.

## Негативна перевірка тестового контуру

Кожна мутація створювалася в окремій тимчасовій копії, не в оригінальному контракті. Harness вимагав успішну компіляцію мутанта, повідомлення `[FAIL]` відповідного тесту та ненульовий exit code.

| Мутація | Тест, що зупинив її |
|---|---|
| Заміна повноважень платника | testOnlyPayerApproves |
| Обхід challenge window | testNoPrematureRelease |
| Вимкнення domain/chain guard | testChainChangeRejected |
| Вимкнення перевірки фактичного депозиту | testFeeTokenRejectedAtomically |
| Помилка +1 у розподілі | testFuzzConservation |
| Вимкнення evidence binding | testWrongEvidence |

Під час цієї перевірки виявлено, що npm launcher Foundry 1.7.1 повертав 0 після реального провалу тесту. Пакет містить власний launcher нативного бінарника з передаванням exit code; повторний запуск усіх шести мутацій підтвердив exit=1.

## SQL та API

Обидві міграції виконані в PGlite з PostgreSQL 17.5 WASM. Перевірено numeric atomic money без округлення, uint256 overflow, FK, chain/token allowlist, незмінність умов/подій/журналу, фінальні receipts, допустимі переходи, balanced journal, idempotency, intent-to-transaction та transactional outbox.

Це не перевірка продуктивності чи конкурентного запису на зовнішньому PostgreSQL, а також не повна інтеграція з TA/PostGIS. Company membership, cryptographic wallet challenge, runtime grants, реальний event verification та HTTP middleware залишаються до впровадження.

OpenAPI пройшла стандартний валідатор і JSON Schema fixtures. Перевірено відповідність переліку станів у Solidity/SQL/API, наявність 10 contract actions і Idempotency-Key в кожному POST; actual HTTP requests до сервера не виконувалися, оскільки сервера в пакеті немає.

## Локальні EVM-транзакції

Anvil працював на loopback з chainId=31337. Тест розгорнув mock USDC і контракт, провів funding/accept/delivery/approval/finalize/withdraw та звірив balances/counters.

- **Reorg:** evm_snapshot → deposit → evm_revert; receipt з покинутого блоку не прийнято.
- **Finality fixture:** included receipt не створює projection; тільки після двох додаткових локальних блоків вона змінюється.
- **Duplicate:** повторне споживання receipt не дублює події.
- **Wrong caller:** неправильного caller відхилено через RPC simulation.
- **Payment semantics:** після SETTLED баланс перевізника ще нуль, існує claim; після withdraw баланс збільшується.
- **Transfer failure:** paused mock token не дозволяє withdrawal, claim залишається.
- **Restart fixture:** новий in-memory observer зчитує фінальний receipt і відтворює його стан. Це обмежена перевірка replay, не повна crash-recovery durable indexer з replay усіх блоків.

У локальних логах збережені адреси та tx hashes саме цього запуску. Вони не є адресами Amoy і не призначені для переказів.

## Coverage та попередження

Стандартний `forge coverage` без оптимізації завершився помилкою stack-too-deep. Повторний запуск `forge coverage --ir-minimum --report summary` пройшов, але Foundry попереджає про можливу неточність source mapping; показники слід використовувати як діагностику.

Branch coverage контракту становить лише 58.82%, тому заяви про повне покриття немає. Основний CI-profile test run проходив без `--ir-minimum`; coverage-build не підміняє перевірку цільового артефакту.

Forge lint також вказує на використання block.timestamp у deadline-перевірках і bytes4 cast у тестовому callback. Timestamp є свідомою частиною state machine, а тестовий cast виконується після перевірки довжини; це зафіксовані попередження, не незалежний security sign-off.

Чисте `npm ci --ignore-scripts` спочатку виявило вразливості транзитивного ws через ethers 6.15.0. Ethers оновлено до 6.17.0, lock-файл перегенеровано, повторний npm audit дав 0 відомих вразливостей; після оновлення повторено local EVM, Amoy-config, SQL, API та всі mutation-перевірки.

CI містить `npm audit --audit-level=moderate`, тому нова advisory може зупинити наступний запуск навіть без змін коду. Нуль знахідок npm audit не є аудитом Solidity-контракту або гарантією відсутності ще невідомих вразливостей.

## Підсумковий допуск

**Допущено: передача локального пакета на code review і підготовка окремого інтеграційного PR.** Не допущено: mainnet, реальні гроші або трактування тестового коду як повністю інтегрованої платіжної системи.

Головні blockers: незалежний аудит, невирішена безстрокова недоступність backup arbiter, повний backend/indexer, wallet/company authorization, перевірена Amoy finality, event-to-ledger posting, runtime permissions і правова/операційна модель. GitHub `main` не змінювався, PR не створювався, зовнішні транзакції не надсилалися.
