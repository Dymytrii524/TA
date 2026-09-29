# PR #15: виправлення C03 та регресійні тести

Дата: 22.09.2026. Окремий патч поверх `fdc8d58` виправляє лише формат TransactionIntent.data; не змінює Solidity, ABI, SQL-міграції, бізнес-логіку F05/F07, залежності чи правила гілок ([PR #15](https://github.com/Dymytrii524/TA/pull/15)).

## Зміна схеми

Замість `^0x[0-9a-f]*$` застосовано:

```text
^0x(?:[0-9a-f]{2})*(?![\s\S])
```

Кожна пара hex-цифр представляє один байт. Strict end-of-input не допускає кінцевого LF, CR/CRLF, Unicode line separators або інших символів; це важливо через відмінність Python regex та JavaScript у трактуванні `$`.

Збережено lowercase-only і початковий префікс `0x`. `0x` залишається допустимими порожніми bytes на рівні формату, а `0xdeadbeef` проходить як лексично валідний набір байтів: жоден із цих результатів не підтверджує авторизований або коректний виклик escrow.

## Регресії та CI

- **Спільні fixtures:** `tests/fixtures/calldata.json`: 6 positive, 24 negative. Odd hex, missing prefix, uppercase, leading/trailing/embedded whitespace, LF/CR/CRLF, NUL, U+2028/U+2029 і неправильні JSON-типи.
- **Python:** `tools/check_api.py` валідовує повний TransactionIntent response для кожного fixture через реальний OpenAPI reference. Окремо перевіряє відсутнє обов’язкове data.
- **JavaScript:** той самий parsed data-schema передається subprocess через stdin, а не дублюється hard-coded pattern. JS перевіряє regex/type parity, позитивні bytes через ethers.getBytes і encoding/decoding withdraw із чинного ABI; це не повний JavaScript OpenAPI validator.
- **Негативні controls:** повернення до початкового pattern виявляється odd-hex fixture; неповне виправлення `^0x(?:[0-9a-f]{2})*$` виявляється final-LF fixture у Python.
- **CI:** чинний workflow уже викликає `python tools/check_api.py`, тому нові fixtures автоматично блокувальні. Помилка Node subprocess передається Python через check=True; додатковий workflow або послаблення existing checks не потрібні.

## Фактичні локальні результати

Спочатку нові fixtures запущено проти старої схеми: валідатор завершився з exit 1 на `odd-one-nibble`. Після зміни лише data-schema весь API-набір пройшов; попередні SQL P1/P2 регресії також виконано повторно.

| Перевірка | Результат | Лог |
|---|---|---|
| До виправлення | Очікуваний exit 1 на odd hex | `artifacts/c03/before-fix.log` |
| Python response C03 | 6 positive, 24 negative; missing data rejected; 2 mutations detected | `artifacts/c03/api.log` |
| JS C03 | 6 positive, 24 negative; bytes decoder, actual withdraw ABI round-trip | `artifacts/c03/api.log` |
| Наявні API request/parity checks | 5 positive, 10 negative; OpenAPI 3.1 valid | `artifacts/c03/api.log` |
| SQL P1 | 42 passed | `artifacts/c03/db-p1.log` |
| SQL P2 | 42 passed | `artifacts/c03/db-p2.log` |
| Offline Amoy config | 5 passed, без RPC | `artifacts/c03/amoy-config.log` |
| npm audit | 0 vulnerabilities на момент перевірки | `artifacts/c03/npm-audit.log` |

Результати Solidity/integration попередніх комітів не видаються за нові локальні запуски. Повний GitHub CI на новому SHA слід перевірити після push; workflow містить контрактні, SQL, API та ізольовані local-EVM тести.

## Межі

Це усуває C03 як дефект лексичного формату calldata у схемі. Перевірка реального contract destination, action/selector, повного ABI, sender/chain, authorization і стану залишається завданням майбутнього HTTP-сервісу; regex не замінює цих перевірок.

F05 wallet accounting і F07 inspection window залишаються відкритими. Цей патч не є незалежним аудитом і не містить merge, deployment або дозволу на реальні кошти.
