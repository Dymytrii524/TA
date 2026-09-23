# Web3 Sprint 0: state machine

Цей опис відповідає `TransAtlasEscrow.sol`, а не бажаній майбутній функціональності. Усі дії авторизує відправник звичайної wallet-транзакції; EIP-712, permit та серверний підпис відсутні.

## Стани

```text
None -> Funded -> Active -> Delivered -> Accepted -> Settled
Funded -> Settled                       [cancelUnaccepted]
Active / Delivered / Accepted -> Disputed -> Settled

Settled -> claimable[beneficiary] -> withdraw() -> ERC20 transfer
```

Для уникнення неоднозначності таблиця нижче є нормативною. `None` має код 0 і не зберігається як стан фінансованого escrow в SQL/API.

| Код / стан | Значення |
|---|---|
| 0 None | Контракт ще не знає цей id |
| 1 Funded / FUNDED | Депозит реально отримано, перевізник ще не прийняв умови |
| 2 Active / ACTIVE | Перевізник прийняв точний termsHash |
| 3 Delivered / DELIVERED | Перевізник подав commitment доказу |
| 4 Accepted / ACCEPTED | Платник підтвердив цей доказ; триває challenge window |
| 5 Disputed / DISPUTED | Потрібне рішення уповноваженого арбітра |
| 6 Settled / SETTLED | Депозит розподілено між claimable сторін; transfer окремо |

## Переходи

| Виклик | Звідки → куди | Хто | Точна умова |
|---|---|---|---|
| create | None → Funded | Платник | Унікальний ненульовий id, exact deposit, `now < acceptBy < deliveryBy`, ненульовий commitment |
| accept | Funded → Active | Перевізник | `now <= acceptBy`, expectedTerms дорівнює termsHash |
| cancelUnaccepted | Funded → Settled | Перевізник | Відмова будь-коли до прийняття; весь депозит платнику |
| cancelUnaccepted | Funded → Settled | Платник | Лише `now > acceptBy`; весь депозит платнику |
| submitDelivery | Active → Delivered | Перевізник | `now <= deliveryBy`, ненульовий evidence commitment |
| approveDelivery | Delivered → Accepted | Платник | `now <= deliveryBy`, точний expectedEvidence; releaseAt = now + challengePeriod |
| dispute | Active/Delivered → Disputed | Будь-яка сторона | Ненульовий reason commitment |
| dispute | Accepted → Disputed | Будь-яка сторона | Лише `now < releaseAt`; ненульовий reason commitment |
| escalateOverdue | Active/Delivered → Disputed | Будь-хто | Лише `now > deliveryBy`; гроші не розблоковуються |
| finalize | Accepted → Settled | Будь-хто | `now >= releaseAt`; усе перевізнику |
| resolve | Disputed → Settled | Основний арбітр | `now < disputedAt + arbitrationPeriod`; payerAmount ≤ deposit |
| resolve | Disputed → Settled | Резервний арбітр | `now >= disputedAt + arbitrationPeriod`; payerAmount ≤ deposit |
| withdraw | Стан deal незмінний | Власник claim | claimable > 0; лише на власну адресу |
| setIntakePaused | Стани незмінні | Guardian | Блокує лише нові create |

Точна межа releaseAt належить finalize, а не dispute. Точна межа завершення arbitrationPeriod належить резервному, а не основному арбітру.

## Параметри пілота

- **Challenge window:** 86 400 секунд, у тестах і шаблоні Amoy.
- **Основний арбітраж:** 604 800 секунд після відкриття спору, далі повноваження резервного арбітра.
- **Ліміт угоди:** 10 000 тестових USDC, або `10000000000` atomic.
- **Сукупний ліміт:** 100 000 тестових USDC, включаючи locked та невиведені claimable.
- **Одержувачі:** тільки зафіксовані payer/carrier; арбітр не може вказати довільну адресу.

Ці числа є запропонованими параметрами тестового пілота, не погодженими комерційними умовами. Зміна незмінних параметрів потребує нового розгортання контракту.

## Важливі крайові випадки

- **Відсутність відповіді платника:** Delivered не перетворюється автоматично на payout; після deliveryBy будь-хто відкриває спір.
- **Непрацездатний резервний арбітр:** кошти можуть залишитися заблокованими безстроково; автоматичного третього рівня або mutual-resolution немає.
- **Відмова токена у transfer:** withdraw відкочується повністю, claim зберігається; це не гарантує доступність коштів, доки емітент обмежує адресу.
- **Випадковий ERC20 переказ:** не створює права вимоги; rescue немає, тому сторонні внески можуть бути невивідними.
- **Агреговане виведення:** withdraw виводить усі claims адреси за всіма угодами; подія Withdrawn не має deal_id.
- **Зовнішній час:** всі дедлайни використовують block.timestamp у секундах, а не локальний годинник UI.
- **Відсутність cron усередині EVM:** finalize/escalateOverdue потребують чиєїсь транзакції, навіть якщо час уже настав.
