# Web3 Sprint 0: запуск та передача розробнику

Цей runbook призначений для відтворення локальних перевірок та підготовки окремого Amoy-пілота. Жодна команда пакета автоматично не публікує контракт у зовнішній мережі.

## Локальна перевірка

Використовуйте Linux, Node 20 та Python 3.12+; еталонний запуск виконано на Node 20.20.1/Python 3.14.3. Розпакуйте архів, перейдіть у `web3-sprint-0` і встановіть зафіксовані залежності.

```bash
npm ci --ignore-scripts
python -m pip install -r requirements.txt
set -o pipefail
FOUNDRY_PROFILE=ci node tools/foundry.mjs forge test -vv
python tools/mutations.py
node tests/db.test.mjs
node tests/db-p1.test.mjs
node tests/db-p2.test.mjs
python tools/check_api.py
node tests/amoy-config.test.mjs
```

`npm ci` потребує optional platform dependencies Foundry; не використовуйте `--omit=optional`. Підтримку Windows/macOS обгортка передбачає, але фактичний запуск на них не перевірявся.

Solc 0.8.30 завантажується при першій компіляції; OpenZeppelin 5.4.0, Forge/Anvil 1.7.1, ethers 6.17.0 і PGlite 0.3.14 закріплено через npm lock. Python-файл закріплює прямі залежності валідатора, але не весь транзитивний граф: для жорсткої production-відтворюваності потрібен окремий hashed lock.

### Локальний EVM

У першому терміналі запускається вузол тільки на loopback. У другому тест створює mock token, escrow і проводить транзакції; ключі Anvil не застосовуються в жодній зовнішній мережі.

```bash
# Термінал A
node tools/foundry.mjs anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --silent

# Термінал B
node tools/wait_rpc.mjs
node tests/integration.test.mjs
```

Після перевірки зупиніть вузол Ctrl+C. Адреси/tx hashes в `artifacts/local-evm.log` належать лише одноразовій локальній мережі й не мають відповідників у block explorer Amoy.

### Покриття й ABI

Покриття потребує `--ir-minimum`, бо стандартний coverage-build без оптимізації дає stack-too-deep. Це допоміжний вимір із попередженням Foundry про неточність source mapping, не основний production compilation profile.

```bash
node tools/foundry.mjs forge coverage --ir-minimum --report summary
node tools/foundry.mjs forge inspect TransAtlasEscrow abi --json
```

Не поєднуйте невдалу перевірку з подальшою командою так, щоб втратити її exit code. Для логів через `tee` обов’язково вмикайте `set -o pipefail`.

### API та C03

`python tools/check_api.py` перевіряє повні TransactionIntent responses на спільних `tests/fixtures/calldata.json`, потім передає розібрану data-схему через stdin у `tests/api-calldata.test.mjs`. Node subprocess має check=True: його помилка зупиняє перевірку й CI. Не запускайте цей JS-файл без schema stdin; основна команда відтворення та `npm run test:api` запускають весь набір.

Calldata має бути парним lowercase hex без whitespace/line terminators; використано строгий кінець вводу `(?![\s\S])`, а не `$`. Порожні bytes `0x` збережено як лексично валідні, але майбутній сервіс повинен перевіряти destination, action/selector і повні ABI arguments; regex не дозволяє вважати довільні bytes коректним escrow-викликом. F05/F07 цей патч не змінює.

## База даних

`tests/db.test.mjs` використовує справжню PostgreSQL-логіку в WASM через PGlite, без зовнішнього сервера. Тестові public.companies/users є мінімальними fixtures, а не повним TA backend.

Порядок майбутньої інтеграції: резервна копія dev-бази; наявна TA міграція з компаніями/користувачами; `001_web3.sql`; `002_ta_foreign_keys.sql`; `003_p1_integrity.sql`; `004_p2_chain_and_finite.sql`; окремі runtime grants без DDL. Міграція 003 обов’язкова до freeze/ingestion; вона відхиляє наявні terms/projections/events і потребує окремого погодженого backfill для старих даних, не видалення історії.

`db.test.mjs` навмисно зберігає legacy baseline 001/002; `db-p1.test.mjs` і `db-p2.test.mjs` тестують актуальний ланцюжок 001/002/003/004. Лише історичні fixtures P2 явно зупиняються після 003, щоб перевірити upgrade. Frozen terms створюються явним списком колонок із nonce та очікуваним terms hash; trigger сам копіює wallet/network/commercial values, і подальший intent читає тільки цей snapshot.

004 бере ACCESS EXCLUSIVE locks і валідовує наявні рядки в одній транзакції; для populated БД потрібне погоджене maintenance window. Помилка `intent_transactions_same_chain`, `deal_price_finite`, `deal_fx_finite`, `snapshot_price_finite` або `snapshot_fx_finite` означає зупинку: виконайте ROLLBACK, збережіть діагностику й погодьте remediation, не вимикайте constraints та не переписуйте frozen history. Коректні дані залишаються незмінними; 004 не є автоматичним backfill і не скасовує вимог 003. Після успішного застосування не запускайте міграції вдруге; production migration runner ще не реалізовано.

Для `create` перший аргумент тепер `escrow_nonce`; canonical ID обчислює контракт із payer-domain, а `tools/escrow-identity.mjs` повторює формулу для сервісу. ABI selector через незмінні типи аргументів не змінився, але семантика змінилася: старі unsigned/signed create intents потрібно відкинути, а не повторно передати.

Міграція 003 перевіряє chain/company при freeze, активність bindings при новому create intent та відповідність funding projection знімку і парі подій. 004 додає F04 same-chain FK і F06 finite checks для price/FX та snapshots. Повний tenant authorization, calldata verification, wallet accounting F05, inspection window F07 та HTTP handlers залишаються окремими задачами; нові бізнес-межі price/FX і серверна валідація не входять у цей патч.

## Підготовка Amoy без broadcast

Шаблон `config/amoy.json` свідомо містить `null` для ролей, адреси контракту та deployment block. Запуск генератора з незаповненим шаблоном повинен завершитися помилкою, а не підставляти випадкові або локальні ключі.

```bash
node tools/foundry.mjs forge build
# Після окремого погодження реальних тестових role addresses:
node tools/amoy_intent.mjs config/amoy.json
```

Генератор перевіряє testnet chain/token/roles/caps/periods і повертає лише unsigned constructor calldata з `broadcast:false`. Він не звертається до RPC, не перевіряє володіння адресами, token bytecode чи наявність gas і не робить deployment.

### Рішення, потрібні перед окремим тестовим розгортанням

- **Адреси:** погодити guardian, основного та резервного арбітра, підтвердити їхній контроль; не брати dummy roles із тестів.
- **Мережа:** незалежно перевірити RPC chainId=80002, token address/decimals, code, gas estimation та джерело тестових токенів.
- **Параметри:** підтвердити строки challenge/arbitration й caps; вони immutable.
- **Доступ:** тестові учасники не передають seed/private key чату, GitHub або конфігурації; підпис відбувається в їхньому гаманці/безпечному signer.
- **Finality:** впровадити й перевірити Amoy-специфічну політику; локальна two-block fixture не підходить.
- **Розгортання:** окремо погодити точні constructor args, signer і calldata; зберегти tx hash, deployed address, runtime code hash, block, ABI і source verification.
- **E2E:** мінімальна тестова сума, happy path, decline/refund, dispute/split, backup, token transfer failure, reconciliation.
- **Допуск:** жодних реальних розрахунків, доки немає незалежного аудиту, повного backend і правового рішення.

Посилання для повторної перевірки: адреса Amoy USDC публікується у [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses), параметри мережі та фінальності у [Polygon RPC documentation](https://docs.polygon.technology/pos/reference/rpc-endpoints) і [Polygon finality documentation](https://docs.polygon.technology/pos/concepts/finality/finality). Перед deployment важлива актуальна перевірка, а не сліпе використання скопійованої конфігурації.

## Перенесення в GitHub TA

Рекомендована структура PR: весь пакет у `web3-sprint-0/`, а workflow з `ci/web3.yml` у `.github/workflows/web3.yml`. Пакет не перезаписує кореневий package.json TA, існуючі міграції або branch ruleset.

- **Review:** перевірити diff, ліцензії залежностей, параметри і явні unresolved risks.
- **CI:** дочекатися `web3-sprint0-tests` та `blockchain-gate` на GitHub; локальний зелений запуск не підміняє remote CI.
- **Захист:** не видаляти чинні required checks; новий gate додавати лише після підтвердженого успішного запуску й перевірки негативної мутації.
- **Secrets:** workflow не має RPC keys, wallet secrets, write permissions або deployment steps.
- **Після merge:** окремий інтеграційний PR для HTTP, identity/wallet binding, indexer, event posting і UI.

## Приймальна задача для AI-розробника

Наведений текст можна передати coding-agent разом із пакетом і доступом до окремої гілки репозиторію. Він не є дозволом на публікацію, merge, підписання транзакцій або використання коштів.

```text
Інтегруй пакет web3-sprint-0 у Dymytrii524/TA в окремій гілці.
Спочатку прочитай README і docs/web3-sprint0-spec.pplx.md.
Не змінюй бізнес-логіку контракту, mainnet guards і чинні CI/ruleset.
Не використовуй приватні ключі, зовнішній deployment або реальні кошти.
Додай лише каталог пакета й additive workflow.
Виконай unit/fuzz/invariant, 7 негативних mutations, SQL (включно з P1/P2),
OpenAPI, offline Amoy-config та local Anvil tests.
Будь-який failed/skipped/cancelled required job означає failure.
Вкажи actual stdout/exit codes і точний git diff.
Не називай OpenAPI реалізованим сервером, PGlite повним TA/PostGIS,
локальний observer production indexer, а SETTLED фактичною виплатою.
Підготуй PR для review, але не merge і не deployment без окремого дозволу.
```
