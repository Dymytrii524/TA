# F05-B: wallet withdrawal та внутрішнє рознесення

Погоджене ADR від 23.09.2026: aggregate withdraw, а деталізація за угодами є
внутрішнім обліком, не полем on-chain Withdrawn. SETTLED не означає paid.

## Реалізація

- `005_wallet_accounting.sql`: typed deal/wallet/contract events, wallet-scoped
  intents, permissions, immutable versioned reconciliation snapshots.
- `runtime/wallet.mjs`: повний канонічний replay Settled/Withdrawn за
  block/transaction/log order. Claim-lots окремі для refund/proceeds, withdrawal
  погашає всі попередні невиведені lots свого account. Точні integer amounts.
- Snapshot містить `lots`, `withdrawals.allocations` і balances. Це append-only
  JSONB subledger policy `F05-B/1`, не бухгалтерські fiat-проводки.
- RPC перевіряє chain, code hash, token, receipt/log, frozen terms,
  canonical anchor, кожен claimable та totalClaimable/totalWithdrawn.
  Невідповідність зупиняє транзакцію, не публікує частковий облік.
- HTTP GET wallets/{binding_id}/claims та POST wallets/{binding_id}/intents:
  verified principal → company permission → active binding; unsigned withdraw-all.
  Немає довільного sender, recipient, amount або deal_id.
- Період підготовки intent: 5 хвилин. Це серверна політика, а не on-chain expiry
  вже підписаного withdraw; фактична сума визначається в момент виконання.

## Інтеграційний контракт і межі

HTTP handler потребує `authenticate(req)` від довіреної TA авторизації. За
замовчуванням доступ заборонено. `wallet_permissions` заповнює тільки довірена
інтеграція; handler не дозволяє користувачу самостійно видавати собі права.
DB adapter потребує `query` і `transaction(callback)` на виділеному connection.
Тести використовують PGlite та локальний HTTP principal adapter, а не production
сесії чинного сайту. Монтування в production auth та багатосесійний PostgreSQL
ще потребують окремої перевірки.

Reconciliation бере весь журнал контракту від deployment_block; це обмежений
пілотний алгоритм, не інкрементальний production indexer. Невідомі frozen deals
або неповна історія блокують reconciliation, не дають фіктивних allocations.
Local Anvil: мінімум два наступні блоки; Amoy: RPC finalized tag, без fallback
на latest. Amoy не підключався й не розгортався.

Pre-finality reorg не впливає на фінальні allocations. Порушення вже записаної
finality зупиняє облік зі збереженням аудиту; автоматичного переписування фінальної
історії немає. Відновлення після такого інциденту потребує окремої погодженої
recovery-процедури, як і базові finality guards Sprint 0.

Міграція відмовляється працювати за наявності історичних Settled/Withdrawn або
deal-scoped withdraw intents: спочатку reviewed backfill. Вона не перепризначає
старі платежі та не видаляє історію.

## Перевірка

`node tests/wallet.test.mjs`: детермінований облік, exact sums, canonical ordering,
refund/proceeds, replay, missing history, SQL typed scope, permissions,
idempotency, revocation, atomic migration refusal.

`node tests/wallet-integration.test.mjs`: справжні локальні EVM receipts →
SQL snapshots → HTTP, два claims і третій між prepare/execution, allocations,
401/403/422, duplicate replay, code/chain/receipt/missing-history negatives,
post-finality halt. CI виконує обидва набори, без deployment.

Не є незалежним аудитом або підтвердженням production-ready статусу. F05-B
реалізовано в межах локального runnable package; production auth, зовнішній
PostgreSQL concurrency та incident recovery залишаються release-критеріями.
