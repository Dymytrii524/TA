# -*- coding: utf-8 -*-
"""Генератор тестових заявок для Trans-Atlas, повністю сумісний з CITIES/CARGO_TYPES/CURRENCIES сайту."""
import json, os, random, re

random.seed(20260905)
REPO = "/home/user/workspace/TA"
OUT = os.path.join(REPO, "test-data")
os.makedirs(OUT, exist_ok=True)

# id, uk, en, country, lat, lon, site_continent, region(file split), roles, is_new
C = [
 # ---------- Europe ----------
 ("kyiv","Київ","Kyiv","UA",50.4501,30.5234,"europe","europe","c",0),
 ("lviv","Львів","Lviv","UA",49.8397,24.0297,"europe","europe","c",0),
 ("odesa","Одеса","Odesa","UA",46.4825,30.7233,"europe","europe","cp",0),
 ("warsaw","Варшава","Warsaw","PL",52.2297,21.0122,"europe","europe","ca",0),
 ("krakow","Краків","Krakow","PL",50.0647,19.9450,"europe","europe","c",0),
 ("gdansk","Гданськ","Gdansk","PL",54.3520,18.6466,"europe","europe","cp",0),
 ("berlin","Берлін","Berlin","DE",52.5200,13.4050,"europe","europe","c",0),
 ("hamburg","Гамбург","Hamburg","DE",53.5511,9.9937,"europe","europe","cp",0),
 ("munich","Мюнхен","Munich","DE",48.1351,11.5820,"europe","europe","c",0),
 ("vilnius","Вільнюс","Vilnius","LT",54.6872,25.2797,"europe","europe","c",0),
 ("prague","Прага","Prague","CZ",50.0755,14.4378,"europe","europe","c",0),
 ("vienna","Відень","Vienna","AT",48.2082,16.3738,"europe","europe","ca",0),
 ("rotterdam","Роттердам","Rotterdam","NL",51.9244,4.4777,"europe","europe","cp",0),
 ("istanbul","Стамбул","Istanbul","TR",41.0082,28.9784,"europe","europe","cpa",0),
 ("constanta","Констанца","Constanta","RO",44.1733,28.6383,"europe","europe","cp",0),
 ("antwerp","Антверпен","Antwerp","BE",51.2194,4.4025,"europe","europe","cp",1),
 ("amsterdam","Амстердам","Amsterdam","NL",52.3676,4.9041,"europe","europe","ca",1),
 ("frankfurt","Франкфурт","Frankfurt","DE",50.1109,8.6821,"europe","europe","ca",1),
 ("paris","Париж","Paris","FR",48.8566,2.3522,"europe","europe","ca",1),
 ("lyon","Ліон","Lyon","FR",45.7640,4.8357,"europe","europe","c",1),
 ("london","Лондон","London","GB",51.5072,-0.1276,"europe","europe","ca",1),
 ("dublin","Дублін","Dublin","IE",53.3498,-6.2603,"europe","europe","cpa",1),
 ("madrid","Мадрид","Madrid","ES",40.4168,-3.7038,"europe","europe","ca",1),
 ("barcelona","Барселона","Barcelona","ES",41.3874,2.1686,"europe","europe","cpa",1),
 ("valencia","Валенсія","Valencia","ES",39.4699,-0.3763,"europe","europe","cp",1),
 ("lisbon","Лісабон","Lisbon","PT",38.7223,-9.1393,"europe","europe","cpa",1),
 ("milan","Мілан","Milan","IT",45.4642,9.1900,"europe","europe","ca",1),
 ("genoa","Генуя","Genoa","IT",44.4056,8.9463,"europe","europe","cp",1),
 ("zurich","Цюрих","Zurich","CH",47.3769,8.5417,"europe","europe","ca",1),
 ("budapest","Будапешт","Budapest","HU",47.4979,19.0402,"europe","europe","ca",1),
 ("sofia","Софія","Sofia","BG",42.6977,23.3219,"europe","europe","ca",1),
 ("belgrade","Белград","Belgrade","RS",44.7866,20.4489,"europe","europe","c",1),
 ("chisinau","Кишинів","Chisinau","MD",47.0105,28.8638,"europe","europe","c",1),
 ("athens","Афіни","Athens","GR",37.9838,23.7275,"europe","europe","ca",1),
 ("piraeus","Пірей","Piraeus","GR",37.9420,23.6465,"europe","europe","cp",1),
 ("riga","Рига","Riga","LV",56.9496,24.1052,"europe","europe","cp",1),
 ("tallinn","Таллінн","Tallinn","EE",59.4370,24.7536,"europe","europe","cp",1),
 ("helsinki","Гельсінкі","Helsinki","FI",60.1699,24.9384,"europe","europe","cpa",1),
 ("stockholm","Стокгольм","Stockholm","SE",59.3293,18.0686,"europe","europe","ca",1),
 ("gothenburg","Гетеборг","Gothenburg","SE",57.7089,11.9746,"europe","europe","cp",1),
 ("oslo","Осло","Oslo","NO",59.9139,10.7522,"europe","europe","cpa",1),
 ("copenhagen","Копенгаген","Copenhagen","DK",55.6761,12.5683,"europe","europe","cpa",1),
 # ---------- Asia ----------
 ("shanghai","Шанхай","Shanghai","CN",31.2304,121.4737,"asia","asia","cpa",0),
 ("shenzhen","Шеньчжень","Shenzhen","CN",22.5431,114.0579,"asia","asia","cp",0),
 ("tokyo","Токіо","Tokyo","JP",35.6762,139.6503,"asia","asia","ca",0),
 ("osaka","Осака","Osaka","JP",34.6937,135.5023,"asia","asia","cp",0),
 ("seoul","Сеул","Seoul","KR",37.5665,126.9780,"asia","asia","ca",0),
 ("mumbai","Мумбаї","Mumbai","IN",19.0760,72.8777,"asia","asia","cpa",0),
 ("delhi","Делі","Delhi","IN",28.7041,77.1025,"asia","asia","ca",0),
 ("bangkok","Бангкок","Bangkok","TH",13.7563,100.5018,"asia","asia","ca",0),
 ("hochiminh","Хошимін","Ho Chi Minh City","VN",10.8231,106.6297,"asia","asia","cpa",0),
 ("singapore","Сінгапур","Singapore","SG",1.3521,103.8198,"asia","asia","cpa",0),
 ("dubai","Дубай","Dubai","AE",25.2048,55.2708,"asia","asia","cpa",0),
 ("riyadh","Ер-Ріяд","Riyadh","SA",24.7136,46.6753,"asia","asia","ca",0),
 ("tbilisi","Тбілісі","Tbilisi","GE",41.7151,44.8271,"asia","asia","c",0),
 ("baku","Баку","Baku","AZ",40.4093,49.8671,"asia","asia","cp",0),
 ("almaty","Алмати","Almaty","KZ",43.2220,76.8512,"asia","asia","c",0),
 ("tashkent","Ташкент","Tashkent","UZ",41.2995,69.2401,"asia","asia","c",0),
 ("yerevan","Єреван","Yerevan","AM",40.1792,44.4991,"asia","asia","c",0),
 ("beijing","Пекін","Beijing","CN",39.9042,116.4074,"asia","asia","ca",1),
 ("guangzhou","Гуанчжоу","Guangzhou","CN",23.1291,113.2644,"asia","asia","cpa",1),
 ("ningbo","Нінбо","Ningbo","CN",29.8683,121.5440,"asia","asia","cp",1),
 ("hongkong","Гонконг","Hong Kong","HK",22.3193,114.1694,"asia","asia","cpa",1),
 ("taipei","Тайбей","Taipei","TW",25.0330,121.5654,"asia","asia","ca",1),
 ("busan","Пусан","Busan","KR",35.1796,129.0756,"asia","asia","cp",1),
 ("incheon","Інчхон","Incheon","KR",37.4563,126.7052,"asia","asia","cpa",1),
 ("chennai","Ченнаї","Chennai","IN",13.0827,80.2707,"asia","asia","cp",1),
 ("hanoi","Ханой","Hanoi","VN",21.0278,105.8342,"asia","asia","ca",1),
 ("jakarta","Джакарта","Jakarta","ID",-6.2088,106.8456,"asia","asia","cpa",1),
 ("manila","Маніла","Manila","PH",14.5995,120.9842,"asia","asia","cpa",1),
 ("kualalumpur","Куала-Лумпур","Kuala Lumpur","MY",3.1390,101.6869,"asia","asia","ca",1),
 ("portklang","Порт-Кланг","Port Klang","MY",3.0031,101.3928,"asia","asia","cp",1),
 ("laemchabang","Лаем-Чабанг","Laem Chabang","TH",13.0833,100.8833,"asia","asia","cp",1),
 ("doha","Доха","Doha","QA",25.2854,51.5310,"asia","asia","cpa",1),
 ("karachi","Карачі","Karachi","PK",24.8607,67.0011,"asia","asia","cp",1),
 ("colombo","Коломбо","Colombo","LK",6.9271,79.8612,"asia","asia","cp",1),
 ("dhaka","Дакка","Dhaka","BD",23.8103,90.4125,"asia","asia","ca",1),
 ("tehran","Тегеран","Tehran","IR",35.6892,51.3890,"asia","asia","c",1),
 # ---------- Africa ----------
 ("cairo","Каїр","Cairo","EG",30.0444,31.2357,"africa","africa","ca",0),
 ("lagos","Лагос","Lagos","NG",6.5244,3.3792,"africa","africa","cpa",0),
 ("casablanca","Касабланка","Casablanca","MA",33.5731,-7.5898,"africa","africa","cpa",0),
 ("johannesburg","Йоганнесбург","Johannesburg","ZA",-26.2041,28.0473,"africa","africa","ca",0),
 ("nairobi","Найробі","Nairobi","KE",-1.2921,36.8219,"africa","africa","ca",0),
 ("accra","Аккра","Accra","GH",5.6037,-0.1870,"africa","africa","ca",0),
 ("tunis","Туніс","Tunis","TN",36.8065,10.1815,"africa","africa","cpa",0),
 ("addisababa","Аддис-Абеба","Addis Ababa","ET",9.0250,38.7469,"africa","africa","ca",0),
 ("alexandria","Александрія","Alexandria","EG",31.2001,29.9187,"africa","africa","cp",1),
 ("portsaid","Порт-Саїд","Port Said","EG",31.2653,32.3019,"africa","africa","cp",1),
 ("tangier","Танжер","Tangier","MA",35.7595,-5.8340,"africa","africa","cp",1),
 ("algiers","Алжир","Algiers","DZ",36.7538,3.0588,"africa","africa","cpa",1),
 ("tripoli","Триполі","Tripoli","LY",32.8872,13.1913,"africa","africa","cp",1),
 ("abidjan","Абіджан","Abidjan","CI",5.3600,-4.0083,"africa","africa","cp",1),
 ("dakar","Дакар","Dakar","SN",14.7167,-17.4677,"africa","africa","cpa",1),
 ("douala","Дуала","Douala","CM",4.0511,9.7679,"africa","africa","cp",1),
 ("mombasa","Момбаса","Mombasa","KE",-4.0435,39.6682,"africa","africa","cp",1),
 ("daressalaam","Дар-ес-Салам","Dar es Salaam","TZ",-6.7924,39.2083,"africa","africa","cpa",1),
 ("kampala","Кампала","Kampala","UG",0.3476,32.5825,"africa","africa","c",1),
 ("durban","Дурбан","Durban","ZA",-29.8587,31.0218,"africa","africa","cpa",1),
 ("capetown","Кейптаун","Cape Town","ZA",-33.9249,18.4241,"africa","africa","cpa",1),
 ("luanda","Луанда","Luanda","AO",-8.8390,13.2894,"africa","africa","cp",1),
 ("maputo","Мапуту","Maputo","MZ",-25.9692,32.5732,"africa","africa","cp",1),
 ("lusaka","Лусака","Lusaka","ZM",-15.3875,28.3228,"africa","africa","c",1),
 ("harare","Гараре","Harare","ZW",-17.8252,31.0335,"africa","africa","c",1),
 ("windhoek","Віндгук","Windhoek","NA",-22.5597,17.0832,"africa","africa","c",1),
 # ---------- North America ----------
 ("newyork","Нью-Йорк","New York","US",40.7128,-74.0060,"america","north-america","cpa",0),
 ("losangeles","Лос-Анджелес","Los Angeles","US",34.0522,-118.2437,"america","north-america","cpa",0),
 ("toronto","Торонто","Toronto","CA",43.6532,-79.3832,"america","north-america","ca",0),
 ("vancouver","Ванкувер","Vancouver","CA",49.2827,-123.1207,"america","north-america","cpa",0),
 ("mexicocity","Мехіко","Mexico City","MX",19.4326,-99.1332,"america","north-america","ca",0),
 ("chicago","Чикаго","Chicago","US",41.8781,-87.6298,"america","north-america","ca",1),
 ("houston","Х'юстон","Houston","US",29.7604,-95.3698,"america","north-america","cpa",1),
 ("dallas","Даллас","Dallas","US",32.7767,-96.7970,"america","north-america","ca",1),
 ("atlanta","Атланта","Atlanta","US",33.7490,-84.3880,"america","north-america","ca",1),
 ("miami","Маямі","Miami","US",25.7617,-80.1918,"america","north-america","cpa",1),
 ("seattle","Сіетл","Seattle","US",47.6062,-122.3321,"america","north-america","cpa",1),
 ("longbeach","Лонг-Біч","Long Beach","US",33.7701,-118.1937,"america","north-america","cp",1),
 ("savannah","Саванна","Savannah","US",32.0809,-81.0912,"america","north-america","cp",1),
 ("memphis","Мемфіс","Memphis","US",35.1495,-90.0490,"america","north-america","ca",1),
 ("denver","Денвер","Denver","US",39.7392,-104.9903,"america","north-america","c",1),
 ("laredo","Ларедо","Laredo","US",27.5064,-99.5075,"america","north-america","c",1),
 ("montreal","Монреаль","Montreal","CA",45.5019,-73.5674,"america","north-america","cpa",1),
 ("calgary","Калгарі","Calgary","CA",51.0447,-114.0719,"america","north-america","ca",1),
 ("winnipeg","Вінніпег","Winnipeg","CA",49.8951,-97.1384,"america","north-america","c",1),
 ("monterrey","Монтеррей","Monterrey","MX",25.6866,-100.3161,"america","north-america","ca",1),
 ("guadalajara","Гвадалахара","Guadalajara","MX",20.6597,-103.3496,"america","north-america","c",1),
 ("veracruz","Веракрус","Veracruz","MX",19.1738,-96.1342,"america","north-america","cp",1),
 ("manzanillo","Мансанільо","Manzanillo","MX",19.0522,-104.3158,"america","north-america","cp",1),
 ("panamacity","Панама","Panama City","PA",8.9824,-79.5199,"america","north-america","cpa",1),
 # ---------- South America ----------
 ("saopaulo","Сан-Паулу","São Paulo","BR",-23.5505,-46.6333,"america","south-america","ca",0),
 ("buenosaires","Буенос-Айрес","Buenos Aires","AR",-34.6037,-58.3816,"america","south-america","cpa",0),
 ("santiago","Сантьяго","Santiago","CL",-33.4489,-70.6693,"america","south-america","ca",0),
 ("bogota","Богота","Bogotá","CO",4.7110,-74.0721,"america","south-america","ca",0),
 ("lima","Ліма","Lima","PE",-12.0464,-77.0428,"america","south-america","ca",0),
 ("santos","Сантус","Santos","BR",-23.9608,-46.3336,"america","south-america","cp",1),
 ("riodejaneiro","Ріо-де-Жанейро","Rio de Janeiro","BR",-22.9068,-43.1729,"america","south-america","cpa",1),
 ("paranagua","Паранагуа","Paranagua","BR",-25.5163,-48.5225,"america","south-america","cp",1),
 ("portoalegre","Порту-Алегрі","Porto Alegre","BR",-30.0346,-51.2177,"america","south-america","c",1),
 ("manaus","Манаус","Manaus","BR",-3.1190,-60.0217,"america","south-america","ca",1),
 ("recife","Ресіфі","Recife","BR",-8.0476,-34.8770,"america","south-america","cp",1),
 ("callao","Кальяо","Callao","PE",-12.0565,-77.1181,"america","south-america","cp",1),
 ("guayaquil","Гуаякіль","Guayaquil","EC",-2.1894,-79.8891,"america","south-america","cpa",1),
 ("quito","Кіто","Quito","EC",-0.1807,-78.4678,"america","south-america","ca",1),
 ("cartagena","Картахена","Cartagena","CO",10.3910,-75.4794,"america","south-america","cp",1),
 ("medellin","Медельїн","Medellín","CO",6.2442,-75.5812,"america","south-america","ca",1),
 ("valparaiso","Вальпараїсо","Valparaiso","CL",-33.0472,-71.6127,"america","south-america","cp",1),
 ("antofagasta","Антофагаста","Antofagasta","CL",-23.6509,-70.3975,"america","south-america","cp",1),
 ("montevideo","Монтевідео","Montevideo","UY",-34.9011,-56.1645,"america","south-america","cpa",1),
 ("asuncion","Асунсьйон","Asunción","PY",-25.2637,-57.5759,"america","south-america","c",1),
 ("lapaz","Ла-Пас","La Paz","BO",-16.4897,-68.1193,"america","south-america","c",1),
 ("caracas","Каракас","Caracas","VE",10.4806,-66.9036,"america","south-america","ca",1),
 ("rosario","Росаріо","Rosario","AR",-32.9442,-60.6505,"america","south-america","cp",1),
 ("georgetown","Джорджтаун","Georgetown","GY",6.8013,-58.1551,"america","south-america","cp",1),
 # ---------- Oceania ----------
 ("sydney","Сідней","Sydney","AU",-33.8688,151.2093,"australia","oceania","cpa",0),
 ("melbourne","Мельбурн","Melbourne","AU",-37.8136,144.9631,"australia","oceania","cpa",0),
 ("brisbane","Брисбен","Brisbane","AU",-27.4698,153.0251,"australia","oceania","cpa",0),
 ("perth","Перт","Perth","AU",-31.9505,115.8605,"australia","oceania","ca",0),
 ("auckland","Окленд","Auckland","NZ",-36.8509,174.7645,"australia","oceania","cpa",0),
 ("adelaide","Аделаїда","Adelaide","AU",-34.9285,138.6007,"australia","oceania","cp",1),
 ("darwin","Дарвін","Darwin","AU",-12.4634,130.8456,"australia","oceania","cpa",1),
 ("hobart","Гобарт","Hobart","AU",-42.8821,147.3272,"australia","oceania","cp",1),
 ("fremantle","Фрімантл","Fremantle","AU",-32.0569,115.7439,"australia","oceania","cp",1),
 ("newcastleau","Ньюкасл","Newcastle","AU",-32.9283,151.7817,"australia","oceania","cp",1),
 ("cairns","Кернс","Cairns","AU",-16.9186,145.7781,"australia","oceania","ca",1),
 ("townsville","Таунсвілл","Townsville","AU",-19.2590,146.8169,"australia","oceania","cp",1),
 ("wellington","Веллінгтон","Wellington","NZ",-41.2866,174.7756,"australia","oceania","cpa",1),
 ("christchurch","Крайстчерч","Christchurch","NZ",-43.5321,172.6362,"australia","oceania","ca",1),
 ("tauranga","Тауранга","Tauranga","NZ",-37.6878,176.1651,"australia","oceania","cp",1),
 ("napier","Нейпір","Napier","NZ",-39.4928,176.9120,"australia","oceania","cp",1),
 ("dunedin","Данідін","Dunedin","NZ",-45.8788,170.5028,"australia","oceania","cp",1),
 ("portmoresby","Порт-Морсбі","Port Moresby","PG",-9.4438,147.1803,"australia","oceania","cpa",1),
 ("lae","Лае","Lae","PG",-6.7155,146.9962,"australia","oceania","cp",1),
 ("suva","Сува","Suva","FJ",-18.1416,178.4419,"australia","oceania","cpa",1),
 ("nadi","นаді","Nadi","FJ",-17.8035,177.4144,"australia","oceania","ca",1),
 ("noumea","Нумеа","Noumea","NC",-22.2758,166.4580,"australia","oceania","cp",1),
 ("apia","Апіа","Apia","WS",-13.8333,-171.7667,"australia","oceania","cp",1),
]
# typo guard
C = [(cid, uk.replace("นаді", "Наді"), en, cc, la, lo, cont, reg, roles, new) for (cid, uk, en, cc, la, lo, cont, reg, roles, new) in C]

REGIONS = ["europe", "asia", "africa", "north-america", "south-america", "oceania"]
NAMES = {"europe": "Europe", "asia": "Asia", "africa": "Africa",
         "north-america": "North America", "south-america": "South America", "oceania": "Oceania"}

# валюти лише з CURRENCIES сайту
CUR = {
 "europe": ["EUR","EUR","EUR","PLN","UAH","CZK","RON","GBP","CHF","HUF","BGN","SEK","DKK","NOK","TRY","RSD","MDL","USD","EURC"],
 "asia": ["USD","USD","CNY","CNY","JPY","KRW","INR","SGD","AED","TRY","GEL","AZN","KZT","UZS","AMD","USDT"],
 "africa": ["USD","USD","EUR","EUR","USD","USDT","USDC"],
 "north-america": ["USD","USD","USD","CAD","MXN","USDC"],
 "south-america": ["USD","USD","USD","EUR","USDT"],
 "oceania": ["USD","USD","EUR","SGD","USDC"],
}
MODES = ["auto","rail","sea","air","drone","multi"]
CARGO = ["build","electro","metal","chem","food","furn","agro","textile","docs"]  # = CARGO_TYPES сайту
DRONE_CARGO = ["docs","docs","electro","food"]
DRONE_TYPES = ["мультикоптер","конвертоплан","літакового типу","гібридний"]
MULTI_COMPONENTS = [["auto","rail"],["sea","auto"],["sea","rail"],["air","auto"],["rail","auto"],["sea","rail","auto"],["air","rail"]]
COMPANIES = {
 "europe": ["ТзОВ «Карпат-Логістика»","FastRoad Sp. z o.o.","АгроТранс Груп","Blue Line Shipping","AirCargo Bavaria","Meble-Trans","Baltic Grain Co.","CentroRail Cargo","NordTrans AG","ChemLog GmbH","Anatolia Freight","УкрМеталТранс","Rhein Спедиція ТзОВ","Sarmatia Логістика s.r.o.","Marina Freight","Iberia Cargo SL","Nordic Rail Cargo AB","Adria Spedition d.o.o."],
 "asia": ["Sinotrans Logistics Co.","Pacific Rim Freight Ltd.","Nippon Cargo Lines","Hanjin Logistics Corp.","Bharat Freight Pvt Ltd","Mekong Shipping JSC","Gulf Cargo LLC","Silk Road Logistics","Asia Star Forwarding","Tashkent Trans Group","Sunrise Rail Cargo","Orient Air Freight","Caspian Spedition LLC","Malacca Lines Sdn Bhd"],
 "africa": ["Sahara Freight Ltd.","Nile Logistics SAE","Transafrica Cargo Ltd.","Maghreb Spedition SARL","West Coast Shipping Nig. Ltd.","East Africa Rail Cargo","Cape Cargo (Pty) Ltd","Savanna Air Freight","Atlas Trans SARL","Zambezi Logistics Ltd.","Gulf of Guinea Shipping Ltd."],
 "north-america": ["Continental Freight Inc.","Great Lakes Logistics LLC","Pacific Northwest Cargo","Maple Leaf Transport Ltd.","Rio Grande Carriers SA de CV","Union Rail Cargo Co.","Atlantic Marine Freight","SkyBridge Air Cargo Inc.","Heartland Trucking LLC","Aztec Logistica SA","Border Express Logistics Inc."],
 "south-america": ["Andes Cargo SA","Amazonas Logistica Ltda","Rio Freight Forwarding SA","Pampas Transportes SRL","Pacifico Shipping Ltda","Atlantico Sul Cargo","Altiplano Rail Cargo","Condor Air Freight SA","Mercosur Spedition SRL","Guayas Logistics CA"],
 "oceania": ["Southern Cross Freight Pty Ltd","Tasman Logistics Ltd","Coral Sea Shipping Pty Ltd","Outback Transport Pty Ltd","Kiwi Cargo Ltd","Pacific Islands Freight Ltd","Aussie Rail Cargo Pty Ltd","Oceania Air Freight Ltd","Great Barrier Logistics","Papua Trans Ltd"],
}

BY_REGION = {r: [c for c in C if c[7] == r] for r in REGIONS}
COUNTRY = {c[0]: c[3] for c in C}


def pool(region, mode):
    cs = BY_REGION[region]
    if mode == "sea":
        sel = [c for c in cs if "p" in c[8]]
    elif mode == "air":
        sel = [c for c in cs if "a" in c[8]]
    else:
        sel = cs
    return [c[0] for c in sel]


def pick_pair(p, domestic_share=0.28):
    """Змішує внутрішні (одна країна) та міжнародні маршрути, щоб фільтр
    Кордони/borderScope і таблиці потоків мали дані в обох напрямках."""
    for _ in range(40):
        a, b = random.choice(p), random.choice(p)
        if a == b:
            continue
        same = COUNTRY[a] == COUNTRY[b]
        if same and random.random() > domestic_share:
            continue
        if not same and random.random() > (1 - domestic_share) + 0.5:
            continue
        return a, b
    a = random.choice(p)
    b = random.choice([x for x in p if x != a])
    return a, b


def rnd_date():
    m = random.choice([9, 9, 10, 10, 11, 12])
    return "2026-%02d-%02d" % (m, random.randint(1, 28))


def make(idx, region, mode):
    frm, to = pick_pair(pool(region, mode))
    it = {"id": idx, "kind": random.choice(["cargo", "transport"]), "mode": mode,
          "continent": NAMES[region], "from": frm, "to": to, "date": rnd_date()}
    if mode == "multi":
        it["components"] = random.choice(MULTI_COMPONENTS)
    if mode == "drone":
        it["cargo"] = random.choice(DRONE_CARGO)
        it["weight"] = round(random.uniform(0.5, 25), 1)
        it["weightUnit"] = "kg"
        it["price"] = float(round(random.uniform(80, 900)))
    else:
        it["cargo"] = random.choice(CARGO)
        if mode == "air":
            it["weight"] = round(random.uniform(0.5, 12), 1); it["volume"] = float(round(random.uniform(2, 40))); it["price"] = float(round(random.uniform(900, 9000)))
        elif mode == "sea":
            it["weight"] = round(random.uniform(15, 260), 1); it["volume"] = float(round(random.uniform(40, 900))); it["price"] = float(round(random.uniform(1200, 22000)))
        elif mode == "rail":
            it["weight"] = round(random.uniform(25, 120), 1); it["volume"] = float(round(random.uniform(60, 220))); it["price"] = float(round(random.uniform(800, 12000)))
        elif mode == "multi":
            it["weight"] = round(random.uniform(10, 140), 1); it["volume"] = float(round(random.uniform(30, 400))); it["price"] = float(round(random.uniform(1000, 18000)))
        else:
            it["weight"] = round(random.uniform(1.5, 24), 1); it["volume"] = float(round(random.uniform(8, 92))); it["price"] = float(round(random.uniform(300, 6000)))
    it["currency"] = random.choice(CUR[region])
    it["company"] = random.choice(COMPANIES[region])
    if mode == "drone":
        it["rangeKm"] = random.choice([15, 25, 40, 60, 80, 120, 200])
        it["maxPayloadKg"] = random.choice([2, 5, 8, 10, 15, 25, 40])
        it["droneType"] = random.choice(DRONE_TYPES)
        it["flightPermit"] = random.random() < 0.7
    return it


TARGET = {  # фіксовані кількості 100-300 на пару континент x вид транспорту
 "europe": {"auto": 300, "rail": 220, "sea": 240, "air": 200, "drone": 150, "multi": 235},
 "asia": {"auto": 260, "rail": 210, "sea": 300, "air": 240, "drone": 140, "multi": 220},
 "africa": {"auto": 230, "rail": 150, "sea": 230, "air": 180, "drone": 120, "multi": 190},
 "north-america": {"auto": 290, "rail": 200, "sea": 190, "air": 210, "drone": 130, "multi": 200},
 "south-america": {"auto": 240, "rail": 160, "sea": 220, "air": 180, "drone": 110, "multi": 180},
 "oceania": {"auto": 210, "rail": 140, "sea": 200, "air": 170, "drone": 110, "multi": 165},
}

ID = 100000
summary = {"generated": "2026-09-04", "idRange": {}, "cityIdsSource": "CITIES (index.html)",
           "continents": {}, "totals": {"listings": 0, "files": 0}}
start_id = ID + 1
for region in REGIONS:
    agg, per_mode = [], {}
    for mode in MODES:
        n = TARGET[region][mode]
        items = []
        for _ in range(n):
            ID += 1
            items.append(make(ID, region, mode))
        per_mode[mode] = n
        agg.extend(items)
        with open(os.path.join(OUT, "listings-%s-%s.json" % (region, mode)), "w", encoding="utf-8") as f:
            json.dump({"continent": NAMES[region], "mode": mode, "count": n, "listings": items}, f, ensure_ascii=False, indent=1)
        summary["totals"]["files"] += 1
    with open(os.path.join(OUT, "listings-%s.json" % region), "w", encoding="utf-8") as f:
        json.dump({"continent": NAMES[region], "count": len(agg), "byMode": per_mode, "listings": agg}, f, ensure_ascii=False, indent=1)
    summary["totals"]["files"] += 1
    summary["totals"]["listings"] += len(agg)
    summary["continents"][region] = {"name": NAMES[region], "total": len(agg), "byMode": per_mode,
                                     "file": "listings-%s.json" % region,
                                     "modeFiles": ["listings-%s-%s.json" % (region, m) for m in MODES]}
summary["idRange"] = {"from": start_id, "to": ID}
summary["files"] = ["listings-%s.json" % r for r in REGIONS]
with open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=1)

# ---- JS-рядки нових міст для CITIES ----
new_lines = []
for cid, uk, en, cc, la, lo, cont, reg, roles, new in C:
    if not new:
        continue
    new_lines.append('  {id:"%s", uk:"%s", en:"%s", lat:%s, lon:%s, country:"%s", continent:"%s"}' % (cid, uk, en, la, lo, cc, cont))
with open(os.path.join(OUT, "cities-extra.js.txt"), "w", encoding="utf-8") as f:
    f.write(",\n".join(new_lines))

print("listings:", summary["totals"]["listings"], "files:", summary["totals"]["files"] + 1)
print("new cities:", len(new_lines), "total cities:", len(C))
for r in REGIONS:
    print(r, summary["continents"][r]["total"], summary["continents"][r]["byMode"])
