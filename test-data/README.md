# test-data — згенеровані тестові заявки

Набір синтетичних заявок для тестування форм і фільтрів логістичної біржі.

## Структура

- `listings-<continent>.json` — агрегований файл по континенту (усі види транспорту)
- `listings-<continent>-<mode>.json` — окремо по виду транспорту
- `summary.json` — зведення: кількості по континентах і видах транспорту

Континенти: `europe`, `asia`, `africa`, `north-america`, `south-america`, `oceania`
Види транспорту: `auto`, `rail`, `sea`, `air`, `drone`, `multi`

На кожну пару континент × вид транспорту — від 100 до 300 заявок. Загалом 7120 заявок у 42 файлах + `summary.json`.

## Модель даних

Поля відповідають демо-масиву заявок у `index.html`:
`id`, `kind` (`cargo`|`transport`), `mode`, `continent`, `from`, `to`, `date`, `cargo`, `weight`, `volume`, `price`, `currency`, `company`.

Для `mode: "multi"` додається `components` (наприклад `["sea","auto"]`).
Для `mode: "drone"` — `weightUnit`, `rangeKm`, `maxPayloadKg`, `droneType`, `flightPermit` (узгоджено з `schemas/post-drone.schema.json`).

## Примітка

Дані синтетичні: маршрути побудовані на реальних містах, портах і хабах, ціни/ваги/валюти згенеровані у реалістичних діапазонах для кожного виду транспорту. Не використовувати як комерційну інформацію.
