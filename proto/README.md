# Контракт модуля SEARCH — `transatlas.search.v1`

gRPC-контракт модуля пошуку вантажів і маршрутів. Виведений із додатка A
(«Алгоритм пошуку вантажів і маршрутів», ТЗ) і з нормативної схеми
`schemas/post-drone.schema.json`.

| Файл | Вміст |
| --- | --- |
| `transatlas/search/v1/common.proto` | Спільні типи: `TransportMode`, `PointKind`, `Point`, `PlaceQuery`, `GeoArea`, `Dimensions`, `Company`, `SearchContext`, розширення `wire` |
| `transatlas/search/v1/routes.proto` | Пошук маршрутів: `SearchRoutesRequest/Response`, `Route`, `Leg`, `Weather`, дрон-частина A.8.4 (`DroneDiagnostics`, `DroneCta`, `DroneSkipped`) |
| `transatlas/search/v1/lots.proto` | Пошук лотів: `SearchLotsRequest/Response`, `Lot`, підказки точок, оцінка маршруту |
| `transatlas/search/v1/service.proto` | `SearchService`: сім методів, зокрема серверний стрім `WatchRouteSearch` |

Обсяг: 29 повідомлень, 14 перерахувань, 1 сервіс.

## Головне правило: нормативна — схема, не proto

Машинним нормативом дрон-частини відповіді `/search/routes` є
`schemas/post-drone.schema.json` (розділ A.8.4.2 ТЗ). Ці `.proto` — типізоване
подання того самого контракту для gRPC і для генерації SDK.

**Розбіжність proto зі схемою — це дефект proto, а не схеми.** Її не
«узгоджують домовленістю», а виправляють у proto. Перевірка
`schemas/check_proto_contract.py` звіряє їх машинно (100 перевірок) і падає при
будь-якому розходженні.

## Відображення в JSON

Дві системи бачать один контракт по-різному: клієнт біржі — як JSON,
внутрішні сервіси — як gRPC. Щоб подання не розійшлися, відображення описане
в самому контракті, а не в коді двох сервісів.

### Імена полів

Кодування protojson **обовʼязково** з `preserving_proto_field_name` (у Go —
`protojson.MarshalOptions{UseProtoNames: true}`, у buf/ES — `json_types`).
Типове поведінка protojson перетворює `total_cost_eur` на `totalCostEur`, а
JSON Schema вимагає `snake_case`. Без цієї опції відповідь модуля перестає
проходити валідацію схемою — і саме тому це не «стильова» настройка.

### Значення перерахувань

Символьні імена proto (`TRANSPORT_MODE_AUTO`) не збігаються з рядками JSON
(`"A"`). Відображення несе опція `wire` (розширення `EnumValueOptions`,
номер 50001), оголошена в `common.proto`:

```protobuf
enum TransportMode {
  TRANSPORT_MODE_AUTO = 1 [(wire) = "A"];
}
```

Перевірка P1 звіряє набір значень `wire` кожного перерахування з відповідним
`enum` у JSON Schema на рівність множин: ні зайвих, ні пропущених.

| Перерахування | Значення `wire` |
| --- | --- |
| `TransportMode` | `A`, `T`, `F`, `M`, `D`, `X` |
| `PointKind` | `city`, `rail_station`, `seaport`, `airport`, `drone_pad`, `warehouse`, `border_crossing` |
| `RankCriterion` | `cost`, `time`, `balanced` |
| `RouteOrigin` | `branch`, `post_drone` |
| `RouteWarning` | `weather_risk`, `no_permit`, `customs_missing`, `low_rating`, `blacklisted`, `estimated_price` |
| `DroneReason` | `not_last_auto_leg`, `no_permit`, `out_of_range`, `cargo_not_allowed`, `no_drone_lot`, `no_landing_pad`, `max_legs_exceeded`, `extra_leg_disabled`, `drone_disabled`, `timeout` |
| `DroneSkipped` | `timeout` |
| `DroneCtaAction` | `create_lot` |
| `SearchState` | `accepted`, `running`, `completed`, `failed` |
| `LotType` | `free_cargo`, `free_transport`, `tender`, `multimodal` |
| `LoadFill` | `full`, `partial` |
| `LotSort` | `fresh`, `price`, `rating`, `depart` |
| `FreshnessColor` | `green`, `yellow`, `grey` |
| `WeatherStatus` | — (див. нижче: тристан, у JSON `boolean|null`) |

Значення `*_UNSPECIFIED = 0` опції `wire` не мають: у JSON їм відповідає
відсутнє поле, а не рядок.

## Що proto виражає інакше, ніж JSON, і чому

### Погода: `boolean|null` → перерахування з трьох станів

У схемі `weather.ok` має тип `boolean|null`, де `null` означає «джерело
недоступне». У proto3 немає nullable-скаляра, а `bool` із presence розрізняв
би лише два стани. Тому:

| JSON | proto |
| --- | --- |
| `true` | `WEATHER_STATUS_OK` |
| `false` | `WEATHER_STATUS_EXCEEDED` |
| `null` | `WEATHER_STATUS_UNAVAILABLE` |

Різниця змістова: «вітер у межах», «вітер поза межами» і «ми не знаємо» дають
різні рішення в ранжуванні. Перевірка P6 стежить, щоб станів залишалося три.

### `drone_diagnostics` — повідомлення-обгортка, а не `repeated`

Розділ A.8.4 вимагає, щоб при `diagnostics: false` поле було **відсутнє**, а не
порожнє. Порожній `repeated` у proto3 не відрізняється від відсутнього, тому
масив загорнутий у повідомлення з presence: немає обгортки — немає поля.

### Presence там, де «нуль» і «немає даних» — різні стани

`optional` стоїть на `variant_of`, `order_pinned_below`, `drone_skipped`,
`drone_cta`, `wind_ms`, `range_used_km`, `payload_kg`, `weather`, `gate`,
`DroneOptions.allow/allow_extra_leg/diagnostics`. Для `wind_ms` це критично:
«0 м/с» і «даних немає» дають протилежні рішення щодо дронового плеча.

### Плоскі поля дронового плеча

Дронові поля лежать плоско на `Leg` — так само, як у JSON, — а звʼязок «вони
заповнені тільки для плеча `D`» виражений правилом CEL, не вкладеним
повідомленням. Вкладення розійшлося б із нормативним JSON.

### Гроші

`total_cost_eur` — `double`. Це **внутрішня величина ранжування** в базовій
валюті конфігурації (назва збережена для сумісності зі схемою 1.0). Гроші для
показу й для документів беруться в модуля `settlement` і мають десятковий тип:
`Lot.freight_value` — рядок із десятковим числом, не `double`. `double`
допускається лише для величин ранжування (відстані, тривалості, ваги).

## Інваріанти як правила CEL

Правила A.8.4 (1–7) і A.7 закодовані виразами `buf.validate` просто в
контракті, тому їх видно в кожному згенерованому SDK:

- `variant_of` заповнене тоді й лише тоді, коли `origin == post_drone`;
- `order_pinned_below` — лише для дронових варіантів і мусить дорівнювати `variant_of`;
- попередження `weather_risk` на дроновому варіанті вимагає `order_pinned_below`;
- суфікс `_d` у `route_id` ↔ `origin == post_drone`;
- останнє плече — `D` тоді й лише тоді, коли `origin == post_drone`;
- `drone_skipped` ⇒ `partial` ∧ немає дронових маршрутів ∧ немає `drone_cta`;
- діагностика `no_permit` ⇒ якийсь маршрут несе попередження `no_permit`;
- `drone_disabled` ⇒ дронових маршрутів немає; `no_landing_pad` ⇒ `drone_cta` немає;
- база нормування не містить `_d` і не порожня, якщо є дроновий варіант;
- кожне `variant_of` вказує на присутній у відповіді маршрут;
- номер воріт обовʼязковий тоді й лише тоді, коли код причини входить у 1..8.

Останнє правило — саме те місце, де вираз CEL посилається на **номери**
перерахування. Перенумерація `DroneReason` без правки виразу мовчки зламала б
його, тому перевірка P5 звіряє три речі: правило існує, номери причин із
воротами утворюють суцільний діапазон, і межі у виразі дорівнюють цьому
діапазону.

## Межі модуля

У контракті немає ставок, торгів, ескроу й розрахунків: за розділом A.1.3 це
модулі `exchange` і `settlement`. Свідомо не включені `bid-packet` (A.8.5),
`to-multimodal-lot` і збережені пошуки — інакше межа модулів розмиється вже в
контракті.

`SearchRoutes` вимагає gRPC-дедлайну: бюджет пост-обробки дронів —
`min(800 мс, 12% часу пошуку)` (A.10). Понад два перевантаження →
`FAILED_PRECONDITION`. Вихід за бюджет **не є помилкою**: відповідь
повертається з `partial: true` і `drone_skipped: timeout`.

`WatchRouteSearch` стрімить **повні знімки, а не дельти**: прохід закріплення
з A.7 переупорядковує вже видані маршрути, і на дельтах клієнт зібрав би
неправильний порядок.

## Розбіжності з текстом ТЗ — закриті

Обидві знайдені при виведенні контракту й виправлені в тексті ТЗ.
Щоб вони не відросли, кожна закріплена сценаріями прогону
`ci/check_contract_text.py`, який читає текст ТЗ, схему й цей контракт
одночасно і виконується кроком job-а `proto`.

**D-1. Носій коду базової валюти** — закрито. Розділ A.5 описував
`normalization_base` як носія коду валюти, тоді як схема визначає його як
масив `route_id` без суфікса `_d`. Рішення: носієм коду є окреме поле
`base_currency_code`, тепер описане й у тексті ТЗ (A.5, A.8.4.1, A.8.4.2), і в
нормативній схемі як рядок `^[A-Z]{3,4}$`. Додавання необовʼязкового поля —
сумісна правка, тому `$id` схеми лишився `post-drone-1.0.json` (A.13.6).
Межу тримає сама схема: значення виду `"EUR"` у `normalization_base` не
проходить шаблон `route_id` (сценарій N2).

**D-2. Одиниці ваги** — закрито. Розділ A.3.2 подавав вагу в тоннах, а для
дронів — у кілограмах тим самим полем. Рішення: `weight_t` — завжди
тонни, `max_payload_kg` і `Leg.payload_kg` — завжди кілограми, перерахунок
робить модуль. Ворота 4 в A.6.8 і в псевдокоді тепер записані як
`weight_t × 1000 ≤ max_payload_kg`, а не як порівняння без одиниць.

## Версіонування (A.13.6)

Пакет `v1` — публічний контракт клієнта біржі, партнерських інтеграцій і
згенерованих SDK. Несумісна правка не ламає компіляцію цього репозиторію —
вона ламає вже задеплоєних клієнтів у рантаймі, тижнями виглядаючи як «дивні
дані».

Сумісно й дозволено: нові поля, нові значення перерахувань, нові методи.

Несумісно й блокується прогоном `ci/proto_breaking.py`: зникле повідомлення чи
перерахування (B1), зникле поле (B2), перейменування під тим самим номером
(B3), зміна типу або кардинальності (B4), зникле чи перенумероване значення
перерахування (B5), зміна рядка `wire` (B6), зміна методу або типу потоку (B7).

Свідома несумісна зміна робиться **новим пакетом** `transatlas.search.v2` — не
правкою `v1`. Номер поля, що вийшов з обігу, закривається `reserved`, щоб
його не перевикористали.

## Прогони

```bash
# узгодженість proto з нормативною JSON Schema (100 перевірок P1-P6)
python schemas/check_proto_contract.py

# мутації: чи справді ці перевірки падають (12 мутацій, по кожній із P1-P6)
python ci/proto_mutation.py

# сумісність із базовою гілкою (B1-B7)
python ci/proto_breaking.py --base origin/main

# лінт і генерація SDK
buf lint
buf generate
```

Усі три прогони на Python не потребують ні `buf`, ні системного `protoc`:
достатньо `grpcio-tools` із `schemas/requirements.txt`. Оголошення
`buf/validate/validate.proto` вони беруть із `third_party/` (шлях
перевизначається через `--validate-dir` або `PROTOVALIDATE_DIR`), а `buf` —
із залежності реєстру, оголошеної в `buf.yaml`.

У конвеєрі це job `Контракт proto модуля SEARCH`
(`ci/github-actions-contract.yml`), обовʼязковий у правилі захисту гілки
(`ci/ruleset-contract.json`) і зведений у `contract-gate`.

## Джерела

- Правила валідації в контракті: [protovalidate](https://github.com/bufbuild/protovalidate)
- Відображення proto ↔ JSON: [Protocol Buffers, ProtoJSON format](https://protobuf.dev/programming-guides/json/)
- Правила сумісності: [Buf, breaking change detection](https://buf.build/docs/breaking/overview/)
- Presence у proto3: [Application note: field presence](https://protobuf.dev/programming-guides/field_presence/)
