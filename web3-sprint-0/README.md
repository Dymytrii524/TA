# Trans-Atlas Web3 Sprint 0

Єдиний пакет: ТЗ, state machine, OpenAPI, SQL, виконуваний escrow-контракт і перевірки Foundry. Оновлення F05-B/F07-A від 29.09.2026, terms/API V2, лише для локальних тестів та підготовки до Polygon Amoy.

**Не для реальних коштів.** Контракт не проходив незалежний аудит; mainnet заборонено в конструкторі. F05 додає виконуваний wallet HTTP handler та пілотний reconciliation; production auth/indexer, UI-гаманець і зовнішнє розгортання не входять до виконаної реалізації.

## Що відкривати

| Файл | Призначення |
|---|---|
| `docs/web3-sprint0-spec.pplx.md` | Повне ТЗ, модель довіри, критерії приймання |
| `docs/state-machine.md` | Стани, переходи, ролі та точні часові межі |
| `docs/acceptance-report.pplx.md` | Реальні результати перевірок та обмеження |
| `docs/p1-fixes.pplx.md` | Історичний звіт виправлень F01–F03 |
| `docs/p2-fixes.pplx.md` | F04 і скінченність F06: зміни, тести та межі |
| `docs/c03-fix.pplx.md` | C03: строгий формат calldata, Python/JavaScript регресії |
| `docs/f05-b-implementation.md` | F05-B: wallet API, claim-lots/allocations, перевірка RPC та межі production |
| `docs/f07-a-implementation.md` | F07-A: 48h review window, terms/ABI V2, міграція і регресії |
| `db/006_review_window.sql` | Після 005: порожня frozen history, terms V2, незмінний evidence-bound review clock |
| `runtime/wallet.mjs` | Fail-closed HTTP handler і виконуваний reconciliation; auth adapter обов’язковий |
| `db/005_wallet_accounting.sql` | Після 004: typed events/intents, permissions, immutable subledger snapshots |
| `docs/runbook.md` | Локальний запуск, підготовка Amoy, інтеграція в TA |
| `src/TransAtlasEscrow.sol` | Тестовий escrow без комісії та upgrade |
| `api/openapi.yaml` | Контракт HTTP API 3.1, не сервер |
| `db/001_web3.sql` → `002_ta_foreign_keys.sql` → `003_p1_integrity.sql` → `004_p2_chain_and_finite.sql` | Обов’язковий порядок міграцій; snapshot/funding, same-chain FK і скінченність price/FX |
| `test/`, `tests/` | Solidity, SQL, API-конфігурація й локальні RPC-перевірки |
| `config/amoy.json` | Конфігурація testnet із незаповненими ролями |
| `artifacts/` | ABI та журнали фактичних запусків |

## Швидкий запуск

Референсне середовище: Linux, Node 20, Python 3.12+. Команди виконуються з кореня цього пакета; перша компіляція завантажить solc.

```bash
npm ci --ignore-scripts
python -m pip install -r requirements.txt
FOUNDRY_PROFILE=ci node tools/foundry.mjs forge test -vv
python tools/mutations.py
node tests/db.test.mjs
node tests/db-p1.test.mjs
node tests/db-p2.test.mjs
node tests/wallet.test.mjs
node tests/review.test.mjs
python tools/check_api.py
node tests/amoy-config.test.mjs
```

У першому терміналі запустіть лише локальний вузол. В іншому виконайте тест реальних EVM-транзакцій.

```bash
# Термінал A
node tools/foundry.mjs anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --silent
# Термінал B
node tools/wait_rpc.mjs
node tests/integration.test.mjs
node tests/wallet-integration.test.mjs
```

Не використовуйте `node_modules/@foundry-rs/forge/bin.mjs` напряму: під час перевірки його npm-обгортка 1.7.1 повертала код 0 після провалу Forge. Власна `tools/foundry.mjs` запускає закріплений нативний бінарник і передає справжній код завершення; mutation-тести перевіряють цей захист.

`python tools/check_api.py` також запускає C03 response fixtures та дочірній Node-тест з тим самим pattern із фактичного OpenAPI. Перевіряються 6 позитивних і 24 негативні calldata-випадки, відсутнє поле data, Python/JS узгодженість і два негативні regex-controls; це вже входить до чинного Web3 CI без окремого workflow.

## Межа відповідальності

Оновлення PR #21: погоджений ADR-R21-02/B, `F05-B/2` і виправлення R21-01/02/03
описано в `docs/adr-r21-02.pplx.md` та `docs/r21-0{1,2,3}.md`.
Застосовуються міграції 007/008; старі V1 snapshot не переписуються.

R21-04 додає міграцію 009 і causal preflight evidence замість порівняння
SQL/block timestamps. Перед видачею create calldata потрібен trusted
`recordMappingPreflight`; історичний V1 перевіряється повним replay.
Деталі, межі інтеграції та регресії: `docs/r21-04.md`.
Нові команди: `node tests/finality.test.mjs`, `node tests/subsets.test.mjs`,
`node tests/http-errors.test.mjs`, `node tools/r21_mutations.mjs`.
Останні три потребують лише локального Anvil. Dedicated local PostgreSQL 18:
`WEB3_TEST_DATABASE_URL=postgres://web3_test:local-ci-only@127.0.0.1:5432/ta_web3_test`.
Це fixture: тести видаляють його схему, ніколи не вказуйте production DB.
Повторіть finality і subsets із цією змінною для multi-session доказів.
CI також перевіряє backup/restore immutable V1/V2 payloads.

Історичні розділи нижче описують PR #15, а не поточний стан відкритого PR #21.
Новий пакет не є production-релізом: auth adapter, production least-privilege
roles, повний deal HTTP/indexer, recovery та незалежний аудит залишаються окремими.

Контракт керує тестовими токенами, а майбутній сервіс settlement має одноосібно вести журнал обліку за підтвердженими подіями. `SETTLED` означає розподіл права на виведення, а не фактичну оплату: вона настає після успішного `withdraw`.

Пакет розміщено в [PR #15](https://github.com/Dymytrii524/TA/pull/15), без merge та зовнішнього deployment. Виправлення P1 змінює семантику першого аргументу `create`: це payer-local nonce, а не готовий escrow ID; старий calldata повторно використовувати не можна.

Міграція 003 навмисно відхиляє БД з наявними frozen terms, escrow projections або chain events. Для такої БД потрібен окремо перевірений історичний backfill, а не видалення даних чи автоматичне «заморожування» поточних реквізитів.

Міграція 004 застосовується після 003, допускає коректні populated дані, але атомарно зупиняється на cross-chain links або нескінченних/NaN price/FX, включно зі старими snapshots. Вона не переписує історію, не округлює значення та не встановлює нові бізнес-ліміти; F05/F07 залишаються відкритими.
