# Джерела даних — Services

Статус на сьогодні: **Open-Meteo + MeteoAlarm (Погода/Авто), AviationWeather.gov (Погода/Авіа), ДПСУ та granica.gov.pl (Кордони) — живі дані. Довідник (`server/data/directory.json`) — статичний структурований каталог 8 джерел, віддається через `/api/services/directory`.** Важливо не плутати ці два рівні: наявність джерела в довіднику (посилання+опис) НЕ означає, що його *живі* дані вже підключені — це окремий рядок статусу нижче.

| Джерело | URL | У Довіднику? | Живі дані підключено? | Тип доступу | TTL кешу | Ліцензія/атрибуція | Власник конектора |
|---|---|---|---|---|---|---|---|
| Open-Meteo | https://open-meteo.com | — | **Так** (`server/connectors/openMeteoRoad.js`) | REST/JSON, без ключа | 30 хв | Атрибуція бажана, не обов'язкова | — |
| ДПСУ (dpsu.gov.ua) | https://dpsu.gov.ua/en/map | Так | **Так** (`server/connectors/dpsuBorders.js`) — 251 пункт пропуску (авто/жд/море/авіа), кількість авто в черзі, з `<select id="by_name">` на сторінці мапи (JSON/XHR-ендпоінта немає — дані рендеряться прямо в HTML) | HTML, дані вбудовані в атрибути `<option>` | 5 хв | Немає явної ліцензії — throttle + атрибуція обов'язкові | — |
| granica.gov.pl (KAS) | https://granica.gov.pl/index_wait.php?p=u&v=pl&k=w | Так | **Так** (`server/connectors/granicaBorders.js`) — 9 пунктів пропуску UA-PL, розрахунковий час очікування (год) для вантажівок/легкових/автобусів | HTML-таблиця, оновлюється 8×/день | 3 год | Немає явної ліцензії — throttle + атрибуція | — |
| border.gov.md | https://border.gov.md | Так | Ні | HTML, немає публічного API | — | Немає явної ліцензії | — |
| politiadefrontiera.ro | https://www.politiadefrontiera.ro | Так | Ні | HTML, немає публічного API | — | Немає явної ліцензії | — |
| GoSwift / estonianborder.eu | https://www.estonianborder.eu | Так | Ні | Веб-сервіс електронної черги | — | Немає явної ліцензії | — |
| CAREC BCP Monitor | https://cpmm.carecprogram.org/2023-report/bcp-monitor/ | Так | Ні (і не буде «live» — довідкові квартальні дані) | Довідкові/квартальні дані | 30 днів | Довідкові дані — НІКОЛИ не показувати як live-чергу | — |
| IMF PortWatch | https://portwatch.imf.org | Так | Ні (Phase 1 план: iframe-віджет) | Iframe/дані щотижня по вівторках | 24 год | Атрибуція IMF PortWatch обов'язкова | — |
| UNCTAD PLSCI | https://unctadstat.unctad.org/datacentre/reportInfo/US.PLSCI | Так | Ні (довідковий індекс) | Статистична таблиця | — | Атрибуція UNCTAD | — |
| MeteoAlarm | https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-{country}/ | Ні | **Так** (`server/connectors/meteoAlarmAlerts.js`) — накладається на прогноз Погода/Авто за країною; `api.meteoalarm.org` виявився лендінгом, реальні дані — на legacy Atom-фідах (підтверджено: ukraine/poland/germany/austria/netherlands/lithuania/czechia/romania) | Atom/CAP XML, без ключа | 10 хв | CC BY 4.0-подібна, атрибуція обов'язкова (див. `<rights>` у фіді) | — |
| AviationWeather.gov | https://aviationweather.gov/api/data/{metar,taf} | Ні | **Так** (`server/connectors/aviationWeatherAir.js`) — METAR+TAF за ICAO-кодом аеропорту, готова категорія `fltCat` (VFR/MVFR/IFR/LIFR) від самого API. Українські аеропорти (UKBB/UKLL/UKOO) чесно повертають "немає даних" (закритий повітряний простір), а не помилку | JSON, без ключа | 1 хв | Публічні дані уряду США | — |
| Copernicus Marine (CMEMS) | https://marine.copernicus.eu | Ні | Ні | NetCDF, потребує реєстрації | 30 хв (заплановано) | Безкоштовна програма ЄС | — |

## Навмисно НЕ інтегровано (Phase 3, per бриф)

MarineTraffic, VesselFinder, Spire, Terminal49, SeaRates, Sinay, StormGlass (безкоштовний рівень забороняє комерційне використання), Windy, CheckWX, RNE TIS, B2B-фіди залізничних операторів — платні/закриті джерела, потребують перевірки умов переліцензування даних перед будь-якою інтеграцією.

## Правила скрапінгу (для майбутніх HTML-конекторів)

- Описовий User-Agent з контактним посиланням (`server/config.js` → `USER_AGENT`)
- Не частіше 1 запиту на 5 хв на державне джерело
- Exponential backoff, таймаут, структуроване логування (`server/log.js`) при поломці селекторів
- Кожен HTML-конектор — за прапорцем, який можна миттєво вимкнути
