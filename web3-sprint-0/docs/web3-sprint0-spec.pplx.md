# Trans-Atlas: єдиний пакет Web3 Sprint 0

Технічне завдання та виконаний локальний прототип, версія 0.1.0 від 22.09.2026. Пакет об’єднує три замовлені напрями: локальний/Amoy escrow, state machine разом з API та SQL, а також виконувані unit/fuzz/invariant-перевірки.

## Рішення та статус

**Рекомендована межа Sprint 0: тестовий escrow як окремий модуль, а не перенесення всієї біржі в блокчейн.** Побудований контракт працює в локальній EVM, а Amoy підготовлено конфігураційно без зовнішнього розгортання чи використання коштів.

Базою інтеграції є репозиторій `Dymytrii524/TA`, перевірений на commit `df896dc37acb3ae870a8c99437477baa91a21d29`; наявні backend-матеріали, SQL і API не слід підміняти демонстраційним frontend ([репозиторій TA](https://github.com/Dymytrii524/TA), [наявна міграція](https://raw.githubusercontent.com/Dymytrii524/TA/main/sprint-0-backend/db/migrations/001_init.sql), [поточний Node API](https://raw.githubusercontent.com/Dymytrii524/TA/main/server/api.js)).

| Частина | Фактичний результат | Чого тут немає |
|---|---|---|
| Escrow | Solidity-контракт, компіляція, deployment і транзакції в локальному Anvil | Mainnet, аудит, реальні гроші |
| Amoy | Тестовий token allowlist, шаблон параметрів, генератор unsigned deployment calldata | RPC-перевірки Amoy, власники ролей, broadcast, contract address |
| State machine | Формальні переходи, ролі, часові межі, відповідність enum між Solidity/SQL/API | Бізнес-погодження тривалостей і арбітрів |
| API | Валідна OpenAPI 3.1 та позитивні/негативні schema fixtures | HTTP handlers, auth-сервер, WalletConnect/UI |
| SQL | Міграції та реальне виконання на PGlite PostgreSQL WASM | Повне розгортання TA/PostGIS, runtime roles, production backups |
| Тести | Foundry, mutation, SQL, OpenAPI, локальні EVM-транзакції | Незалежний аудит, формальна верифікація, Amoy E2E |
| CI | Additive workflow з fail-closed gate | GitHub PR, remote workflow run, зміна ruleset |

## Архітектура та джерела істини

```text
TA UI + гаманець
  -> TA auth / company membership / KYB / wallet binding [майбутня реалізація]
  -> settlement API: unsigned intent + outbox [специфікація]
  -> гаманець користувача: approve(exact amount), create/accept/... [пілотний контракт]
  -> Anvil або дозволена Amoy
  -> indexer: receipt, canonical block, finality [локальна тестова фікстура]
  -> settlement: SQL projection + balanced journal [схема]
  -> API read model / UI [майбутня реалізація]
```

- **On-chain:** токен, сторони, сума, commitments, дедлайни, стан угоди та claims. Контракт є джерелом істини щодо виконаних токенних операцій.
- **Off-chain:** заявки, ціни у договірній валюті, KYB, членство у компанії, документи, особисті дані, FX snapshot та операційні статуси.
- **Settlement:** єдиний майбутній writer фінансового журналу; worker лише постачає перевірені факти. Не допускаються незалежні записи платежів із frontend, CRM і chain listener.
- **SQL projection:** відображення тільки finalized подій; підтвердження API-запиту, calldata або tx_hash не є фактом оплати.
- **Availability:** недоступність RPC/БД повертає unavailable/pending, а не оптимістичний фінансовий успіх.

Токенним еталоном Amoy обрано Circle test USDC `0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582`, який оприлюднено у списку тестових контрактів Circle ([Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)). Chain ID Amoy становить 80002; параметри підключення слід звірити перед окремим розгортанням ([Polygon RPC endpoints](https://docs.polygon.technology/pos/reference/rpc-endpoints)).

## Функціональні вимоги

### Заморожування умов

- **Deal identity:** business `deal_id` є UUID; випадковий ненульовий `escrow_nonce` має 32 байти й належить платнику. Контракт обчислює `escrow_id = keccak256(abi.encode(keccak256("TRANS_ATLAS_ESCROW_ID_V1"), uint256(chainId), address(this), payer, escrow_nonce))`; зберігати nonce та ID у `deal_terms`, не виводити nonce з ПІБ або документа.
- **Terms snapshot:** до create зафіксувати chain, token, контракт, company/wallet bindings, amount_atomic, acceptBy, deliveryBy, FX snapshot та agreement commitment.
- **Commitment:** запропонований формат для майбутнього document-сервісу: `keccak256(abi.encode(domainVersion, randomNonce32, sha256(fileBytes)))`; nonce зберігається приватно. У контракт передається лише bytes32, а генератор документних commitments не реалізовано.
- **termsHash:** контракт обчислює `keccak256(abi.encode(chainId, contract, id, payer, carrier, token, amount, acceptBy, deliveryBy, agreementCommitment, arbiter, backupArbiter, challengePeriod, arbitrationPeriod))`.
- **Погодження перевізником:** accept вимагає точний expectedTerms; UI повинен відобразити розшифровані умови, а не лише хеш.
- **FX:** fiat-ціна і USDC atomic є різними величинами. Snapshot курсу, напрям конвертації, правило округлення і строк чинності мають бути явними; прототип не виконує реальної FX-конвертації.

### Депозит і виконання

- **Approve:** гаманець платника надає allowance на точну суму, без unlimited approval; API має перевірити правильність spender/token/chain.
- **Create:** депозит і створення Funded атомарні. Відмінність фактичного приросту балансу від amount відхиляє транзакцію.
- **Delivery:** перевізник подає evidence commitment, платник підтверджує саме його. GPS або AI-оцінка не запускають payout.
- **Challenge:** після approveDelivery запускається 24-годинне вікно тестового пілота; спір зупиняє стандартне завершення.
- **Timeout:** прострочення виконання переводиться у спір, а не автоматичний переказ одній стороні.
- **Resolve:** дозволений арбітр визначає повернення платнику в межах депозиту, залишок належить перевізнику.
- **Withdraw:** кожна сторона отримує лише власний агрегований claim; невдалий transfer не стирає вимогу.

Контракт використовує SafeERC20 і ReentrancyGuard із закріпленої OpenZeppelin 5.4.0, але ці компоненти не замінюють перевірку всієї бізнес-логіки ([OpenZeppelin ERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20), [OpenZeppelin utilities](https://docs.openzeppelin.com/contracts/5.x/api/utils)). Використаний pull-withdraw і відокремлення settlement від transfer є проєктними рішеннями цього пакета.

### Модель повноважень

| Роль | Дозволено | Заборонено |
|---|---|---|
| Платник | Create, approve evidence, dispute, refund після acceptBy, withdraw | Приймати від імені перевізника, міняти суму/одержувача |
| Перевізник | Accept, decline до accept, submit evidence, dispute, withdraw | Підтверджувати власну доставку від імені платника |
| Guardian | Зупиняти/відновлювати тільки нові депозити | Withdraw чужих коштів, resolve, заміна ролей |
| Основний арбітр | Resolve до arbitration cutoff | Arbitrary payout, перевищення депозиту |
| Резервний арбітр | Resolve від cutoff | Resolve до cutoff, arbitrary payout |
| Будь-який caller | Finalize після challenge, overdue escalation | Присвоєння депозиту |

Guardian, основний та резервний арбітри мають різні ненульові адреси. Платник і перевізник не можуть бути арбітрами цієї інсталяції; майбутній auth/KYB-контур має перевіряти незалежність юридичних осіб, оскільки різні адреси не доводять незалежність контролю.

## API-контракт і правила інтеграції

Повний машинозчитуваний документ розташований у `api/openapi.yaml`. Це контракт майбутнього сервера, і наведені нижче перевірки авторизації не слід вважати вже працюючим middleware.

| Метод і маршрут | Результат |
|---|---|
| POST `/api/v1/web3/deals/{deal_id}/intents` | Unsigned from/to/data/value, строк чинності, broadcast=false |
| GET `/api/v1/web3/deals/{deal_id}/escrow` | Finalized стан і окремий transaction_status |
| POST `/api/v1/web3/intents/{intent_id}/transactions` | 202 submitted, а не payment success |
| POST `/api/v1/web3/deals/{deal_id}/evidence` | Приватний object reference і commitment, не дозвіл на payout |

- **Auth:** JWT перевіряється сервером; user → company → wallet binding не береться на довіру з request body.
- **Idempotency:** усі POST вимагають ключ; той самий scope+key+body повертає попередній результат, інший body з тим самим ключем дає 409. SQL забезпечує унікальність intent scope; загальний idempotency middleware для evidence/transaction endpoints ще потрібно реалізувати.
- **Amounts:** decimal strings у JSON, uint256/цілі numeric у сховищі; JS Number для atomic заборонений. Верхню межу uint256 сервер перевіряє окремо від regex.
- **Calldata:** response data має формат `0x` + парна кількість lowercase hex-символів, без пробілів або line terminators. Лексично допустиме `0x` не є escrow-викликом; destination, action/selector і ABI arguments перевіряються сервісом окремо. C03 fixtures перевіряють schema в Python та той самий pattern у JavaScript.
- **Create payload:** nonce/amount/deadlines/parties/agreement походять тільки з повного immutable deal_terms snapshot, не через JOIN до поточних mutable deals і не з довільного запиту користувача. Поточний binding використовується лише для перевірки авторизації/відкликання; адреса для calldata береться зі знімка.
- **Replacements:** `intent_transactions` допускає кілька tx_hash одного intent; кожен tx належить одному intent. Міграція 004 забезпечує збіг chain через composite FK; сервер додатково перевіряє chain, sender, to, calldata, nonce/replace semantics.
- **Expiry:** expires_at intent обмежує його підготовку/використання API, але саме по собі не анулює calldata on-chain. Контракт застосовує власні дедлайни/стан; UI не повинен обіцяти криптографічне відкликання intent.
- **Withdraw:** маршрут містить deal_id для business authorization, але контракт виводить aggregate wallet claim. До production потрібне окреме wallet-level представлення та рознесення по угодах, а не хибне трактування «ця одна угода оплачена».
- **Errors:** 401/403/409/422/503, structured problem+json, без витоку чужих документів/реквізитів.

## SQL і облік

Міграція `001_web3.sql` створює окрему схему; `002_ta_foreign_keys.sql` додає зв’язки з наявними public.companies/public.users; обов’язкова `003_p1_integrity.sql` додає immutable snapshots і звірку funding. Остання відхиляє існуючі terms/projections/events, бо історичні умови не можна автоматично відновити з mutable rows; у тестах є тільки мінімальні parent fixtures, не повний TA/PostGIS.

Наступна обов’язкова міграція `004_p2_chain_and_finite.sql` забезпечує однаковий chain intent/transaction association та відхиляє NaN/±Infinity у price_amount/fx_rate й відповідних snapshot-полях. Усі наявні рядки валідовуються без автоматичного переписування: невідповідність зупиняє всю міграцію. Поточні правила позитивності й двох знаків price збережені; нові максимуми й FX precision/scale не встановлені.

| Сутність | Інваріант або роль |
|---|---|
| networks | Chain allowlist, USDC на Amoy, immutable контракт/code hash |
| wallet_bindings | Незмінна identity/challenge, активна унікальна адреса, односпрямоване відкликання |
| deals | Компанії, fiat price, FX snapshot, agreement commitment |
| deal_terms | Immutable pre-funding nonce/id/hash, wallet/network values, commercial/FX snapshot, amount/deadlines |
| intents / intent_transactions | Намір і набір кандидатів транзакцій |
| chain_transactions / chain_events | Receipt, canonical block, log identity, finality |
| escrows | Незмінні principal/terms/funding_event_id, звірка Funded + StateChanged з snapshot, DELETE/TRUNCATE заборонені |
| evidence | Append-only приватні посилання та commitments |
| outbox | Запис у тій самій SQL-транзакції, що intent, а не окремий best-effort POST |
| ledger_entries | Цілі atomic, збалансована операція, один final event, append-only |

SQL не перевіряє криптографічно Ethereum receipt і не знає правдивості довільно записаного payload. Indexer та його runtime DB permissions залишаються частиною довіреної межі; власник міграцій/DB superuser може змінити схему.

Рекомендований майбутній posting plan використовує знакові суми: Funded додає `asset:escrow +A` і `liability:locked:deal -A`; Settled додає `liability:locked:deal +A`, `liability:claim:payer -P`, `liability:claim:carrier -(A-P)` без нульових рядків. Withdrawn додає `liability:claim:wallet +W`, `asset:escrow -W`; автоматичний event-to-ledger posting та розподіл wallet payout по угодах у цьому пакеті не реалізовано.

### Finality, reorg та reconciliation

- **Before finality:** included receipt не змінює фінансову projection; orphaned кандидат відкидається, retries не дублюють події.
- **After finality:** розбіжність canonical hash зупиняє reconciliation, а не тихо переписує облік. SQL забороняє мутацію finalized receipts/events.
- **Replay:** індексатор має відновлюватися з deployment_block з дедуплікацією chain/block/tx/log, перевіркою порядку block/transaction/log та переходів state machine.
- **Тестова межа:** Anvil fixture використовує два додаткові блоки лише локально; P1 funding-сценарій звіряє реальні ABI logs і `getDeal` на finalized block та записує funding у PGlite. Решта lifecycle observer лишається in-memory, без повного SQL journal/indexer.
- **Amoy policy:** перед допуском потрібен окремий перевірений адаптер фінальності та контроль доступності/узгодженості RPC, а не копіювання числа «2 блоки». Модель фінальності Polygon слід брати з актуальної документації ([Polygon finality](https://docs.polygon.technology/pos/concepts/finality/finality)).

## Безпека, приватність та відкриті ризики

- **Кошти:** тільки тестові, без mainnet, fiat custody, bridge або FX execution. Законність майбутнього сервісу не визначається лише технічним терміном «non-custodial».
- **Документи:** жодних CMR, паспортів, GPS-треків, телефонів чи приватних URL on-chain. Hash сам по собі не доводить доставку; навіть commitment потребує оцінки можливості ідентифікації/зв’язування даних ([EDPB Guidelines 02/2025, v2](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_202502_blockchain_v2_en.pdf)).
- **Truth problem:** блокчейн не може самостійно перевірити фізичну доставку; off-chain факти мають окрему модель довіри ([Ethereum oracles](https://ethereum.org/developers/docs/oracles/)).
- **USDC risk:** pause/blacklist/upgrade токена є зовнішньою залежністю; наявність claim не гарантує можливість негайного transfer ([Circle stablecoin contracts](https://github.com/circlefin/stablecoin-evm)).
- **Liveness:** після передачі резервному арбітру немає третього fallback, взаємного підписаного врегулювання або ротації ключів. Втрата резервного ключа може заморозити спір назавжди.
- **Contract access:** API KYB policy можна обійти прямим викликом контракту. On-chain allowlist/attestation для компаній не реалізовано; не заявляти permissioned compliance.
- **Pause:** це intake pause, не emergency freeze усіх функцій. Якщо бізнесу потрібна інша модель, її слід окремо спроєктувати, включно з ризиком блокування виходу.
- **Token economics:** немає комісії біржі, rebate, gas sponsorship, gasless relayer чи escrow yield.
- **Deployment:** параметри і ролі immutable, proxy відсутній; реєстр SQL підтримує один активний deployment на chain. Для наступних версій потрібен явний registry/deployment history, а не update існуючого запису.
- **Аудит:** mutation/fuzz/invariant не є доказом відсутності всіх вразливостей. Міжкомпанійні permissions, runtime grants, raw-log verification, concurrency, резервування і full-stack тести залишаються до інтеграційного спринту.

## Критерії приймання та послідовність інтеграції

| Gate | Критерій | Поточний статус |
|---|---|---|
| Local contract | Позитивний цикл, roles, time boundaries, pause/blacklist/reentrancy, replay | Виконано |
| Foundry | Unit + 2048 fuzz cases + 3 invariants по 256×128 викликів | Виконано |
| Negative CI | Кожна з 6 навмисних мутацій дає test failure і nonzero exit | Виконано |
| API/schema | OpenAPI validator, positive/negative fixtures, enum/action parity | Виконано |
| Database | Міграції, guards, atomic money, journal, immutable terms, FK | Виконано на PGlite |
| Local RPC | Реальні Anvil транзакції, pre-finality rollback, idempotency, withdrawal | Виконано |
| TA integration | HTTP auth + worker + SQL + UI + існуючі CI | Не реалізовано |
| Amoy | Окремо погоджені ролі, RPC/finality, deployment, test token E2E | Не виконано |
| Mainnet | Правовий аналіз, custody policy, аудит, liveness recovery, production operations | Заблоковано |

У репозиторії пакет пропонується розмістити як `web3-sprint-0/`, а `ci/web3.yml` після review скопіювати до `.github/workflows/web3.yml`. Чинні перевірки та ruleset TA слід зберегти без послаблення; новий `blockchain-gate` спочатку має реально пройти на PR, а вже потім ставати обов’язковим.

Наступний інтеграційний спринт має реалізувати HTTP handlers, wallet binding, chain indexer, event-to-ledger posting, runtime DB permissions і UI. Лише після цього має сенс окреме санкціоноване розгортання Amoy; готовність цього локального пакета не означає готовність біржі до реальних розрахунків.
