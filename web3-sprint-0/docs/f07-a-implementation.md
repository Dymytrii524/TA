# F07-A: 48 календарних годин на перевірку доставки

ADR погоджено 23.09.2026. Реалізація 29.09.2026: reviewBy = timestamp успішного
канонічного submitDelivery + 172800 секунд; жодної виплати через мовчання.

## Поведінка та сумісність

- submitDelivery дозволено включно до deliveryBy; повтор у Delivered не скидає clock.
- approveDelivery дозволено включно до reviewBy. Після явного approval починається
  окремий незмінений challengePeriod.
- overdue Active: тільки після deliveryBy; overdue Delivered: тільки після reviewBy.
  Permissionless escalation не розподіляє кошти. Direct dispute сторін збережено.
- Час повідомлень, індексації та місцевий часовий пояс не змінюють on-chain clock.
- Create отримав обов’язковий останній аргумент `uint16 termsVersion=2`.
  Старий selector відхиляється. Новий terms hash включає bytes32 domain
  `keccak256("TRANS_ATLAS_TERMS_V2")` на початку і uint64 reviewPeriod наприкінці.
  Усі поля static ABI; Solidity bytes.concat двох abi.encode тотожний повному
  кодуванню JS, що перевіряє реальний EVM integration.
- EvidenceSubmitted тепер також містить submittedAt/reviewBy; ABI артефакт
  регенеровано. Потрібні V2 decoder/clients; старі signed/prepared create intents
  не переносити, а скасувати й перевидати за окремим планом.
- Цей код не оновлює вже розгорнутий immutable контракт. Мережеві deployment
  та переключення registry не виконуються і потребують окремого дозволу.

## SQL, API і межі

Міграція 006 відмовляється за існуючих frozen terms, projections/events або
live intents; це stop-guard, не автоматичний production backfill.
Нова frozen schema фіксує terms_version=2 і review_period_seconds=172800.
Projection прив’язує review clock до фінальної EvidenceSubmitted безпосередньо
перед StateChanged(Delivered), перевіряє 48h, своєчасність та незмінність.

OpenAPI 0.2.0 вимагає terms_version=2 для create і повертає review clock.
runtime/review.mjs має виконувані clock validation та approve/overdue calldata
guards для перевіреного state/actor. Це не новий production deal HTTP endpoint:
deal routing/auth та повний indexer лишаються інтеграційною роботою.
Wallet HTTP, доданий F05, залишається окремим.

## Фактичні локальні перевірки

- 16 нових Solidity regressions; разом 58 Foundry tests, включно з fuzz 2048 та
  invariants 256×128, 0 failed/skipped.
- 10 mutation controls виявлено; три нові повертають старий approval deadline,
  стару overdue guard та неправильну 24h тривалість.
- 19 API/SQL перевірок + окремий atomic migration refusal.
- Local EVM: доставка на deadline → event/SQL/API clock → approval після deadline;
  pre-finality reorg доставки не публікує orphan reviewBy.
- Старі SQL P1/P2, wallet regression/integration та C03 залишаються в CI.

Докази цього проходу: `artifacts/f07/`. Вони локальні, не незалежний аудит.
Підключення до production TA auth, зовнішній PostgreSQL concurrency,
post-finality incident recovery, UI та реальні кошти не сертифіковано цим патчем.
