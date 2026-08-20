# Джерела даних — Services

Статус на сьогодні: **Open-Meteo (Погода/Авто) — живі дані. Довідник (`server/data/directory.json`) — статичний структурований каталог 8 джерел, віддається через `/api/services/directory`.** Важливо не плутати ці два рівні: наявність джерела в довіднику (посилання+опис) НЕ означає, що його *живі* дані (черги на кордоні, завантаженість порту) вже підключені — це окремий рядок статусу нижче.

| Джерело | URL | У Довіднику? | Живі дані підключено? | Тип доступу | TTL кешу | Ліцензія/атрибуція | Власник конектора |
|---|---|---|---|---|---|---|---|
| Open-Meteo | https://open-meteo.com | — | **Так** (`server/connectors/openMeteoRoad.js`) | REST/JSON, без ключа | 30 хв | Атрибуція бажана, не обов'язкова | — |
| ДПСУ (dpsu.gov.ua) | https://dpsu.gov.ua/en/map | Так | Ні | HTML/JS-карта, немає публічного API | 5 хв (заплановано) | Немає явної ліцензії — throttle + атрибуція обов'язкові | — |
| granica.gov.pl (KAS) | https://granica.gov.pl/index_wait.php?p | Так | Ні | HTML-таблиця, оновлюється 8×/день | 3 год (заплановано) | Немає явної ліцензії — throttle + атрибуція | — |
| border.gov.md | https://border.gov.md | Так | Ні | HTML, немає публічного API | — | Немає явної ліцензії | — |
| politiadefrontiera.ro | https://www.politiadefrontiera.ro | Так | Ні | HTML, немає публічного API | — | Немає явної ліцензії | — |
| GoSwift / estonianborder.eu | https://www.estonianborder.eu | Так | Ні | Веб-сервіс електронної черги | — | Немає явної ліцензії | — |
| CAREC BCP Monitor | https://cpmm.carecprogram.org/2023-report/bcp-monitor/ | Так | Ні (і не буде «live» — довідкові квартальні дані) | Довідкові/квартальні дані | 30 днів | Довідкові дані — НІКОЛИ не показувати як live-чергу | — |
| IMF PortWatch | https://portwatch.imf.org | Так | Ні (Phase 1 план: iframe-віджет) | Iframe/дані щотижня по вівторках | 24 год | Атрибуція IMF PortWatch обов'язкова | — |
| UNCTAD PLSCI | https://unctadstat.unctad.org/datacentre/reportInfo/US.PLSCI | Так | Ні (довідковий індекс) | Статистична таблиця | — | Атрибуція UNCTAD | — |
| MeteoAlarm | https://api.meteoalarm.org/ | Ні | Ні | GeoJSON/CAP | 10 хв (заплановано) | Атрибуція обов'язкова | — |
| AviationWeather.gov | https://aviationweather.gov/data/api/ | Ні | Ні | JSON/GeoJSON, без ключа | 1 хв / 10 хв (заплановано) | Публічні дані США | — |
| Copernicus Marine (CMEMS) | https://marine.copernicus.eu | Ні | Ні | NetCDF, потребує реєстрації | 30 хв (заплановано) | Безкоштовна програма ЄС | — |

## Навмисно НЕ інтегровано (Phase 3, per бриф)

MarineTraffic, VesselFinder, Spire, Terminal49, SeaRates, Sinay, StormGlass (безкоштовний рівень забороняє комерційне використання), Windy, CheckWX, RNE TIS, B2B-фіди залізничних операторів — платні/закриті джерела, потребують перевірки умов переліцензування даних перед будь-якою інтеграцією.

## Правила скрапінгу (для майбутніх HTML-конекторів)

- Описовий User-Agent з контактним посиланням (`server/config.js` → `USER_AGENT`)
- Не частіше 1 запиту на 5 хв на державне джерело
- Exponential backoff, таймаут, структуроване логування (`server/log.js`) при поломці селекторів
- Кожен HTML-конектор — за прапорцем, який можна миттєво вимкнути
