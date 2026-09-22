# Trans-Atlas Web3 Sprint 0

Єдиний пакет: ТЗ, state machine, OpenAPI, SQL, виконуваний escrow-контракт і перевірки Foundry. Версія 0.1.0 від 22.09.2026, лише для локальної мережі та підготовки до Polygon Amoy.

**Не для реальних коштів.** Контракт не проходив незалежний аудит; mainnet заборонено в конструкторі. HTTP-сервер, production-індексатор, UI-гаманець і зовнішнє розгортання не входять до виконаної реалізації.

## Що відкривати

| Файл | Призначення |
|---|---|
| `docs/web3-sprint0-spec.pplx.md` | Повне ТЗ, модель довіри, критерії приймання |
| `docs/state-machine.md` | Стани, переходи, ролі та точні часові межі |
| `docs/acceptance-report.pplx.md` | Реальні результати перевірок та обмеження |
| `docs/runbook.md` | Локальний запуск, підготовка Amoy, інтеграція в TA |
| `src/TransAtlasEscrow.sol` | Тестовий escrow без комісії та upgrade |
| `api/openapi.yaml` | Контракт HTTP API 3.1, не сервер |
| `db/001_web3.sql`, `db/002_ta_foreign_keys.sql` | Схема та FK до наявних companies/users |
| `test/`, `tests/` | Solidity, SQL, API-конфігурація й локальні RPC-перевірки |
| `ci/web3.yml` | Додатковий workflow, ще не встановлений у GitHub |
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
```

Не використовуйте `node_modules/@foundry-rs/forge/bin.mjs` напряму: під час перевірки його npm-обгортка 1.7.1 повертала код 0 після провалу Forge. Власна `tools/foundry.mjs` запускає закріплений нативний бінарник і передає справжній код завершення; mutation-тести перевіряють цей захист.

## Межа відповідальності

Контракт керує тестовими токенами, а майбутній сервіс settlement має одноосібно вести журнал обліку за підтвердженими подіями. `SETTLED` означає розподіл права на виведення, а не фактичну оплату: вона настає після успішного `withdraw`.

Зміни до `Dymytrii524/TA` не надсилалися, PR не створювався, Amoy не розгортався. Пакет підготовлено для окремого review і подальшої інтеграції без послаблення чинних перевірок TA.
