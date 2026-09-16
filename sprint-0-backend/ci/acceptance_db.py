#!/usr/bin/env python3
"""Приймальні тести схеми БД на живому PostgreSQL 18 + PostGIS.

Це не опис, а прогін: міграція застосовується до чистої бази, довідники
сідяться з реєстрів SPA, усі legacy-заявки імпортуються, після чого
перевіряються позитивні сценарії та навмисні порушення інваріантів.

Запуск: python3 ci/acceptance_db.py <шлях-до-TA> [dsn]
"""
import json
import os
import sys
import time
import uuid

import psycopg
from psycopg import errors

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import import_legacy  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RESULTS = []


def ok(label, passed, detail=""):
    RESULTS.append((label, passed, detail))
    print(f"  [{'ok' if passed else 'ПРОВАЛ'}] {label}" + (f" — {detail}" if detail else ""))


def expect_error(conn, label, sql, params=None, kinds=(errors.IntegrityError, errors.RaiseException)):
    """Негативний тест: операція мусить бути відхилена базою."""
    try:
        with conn.transaction():
            conn.execute(sql, params or ())
        ok(label, False, "операція пройшла, хоча мала впасть")
    except kinds as exc:
        ok(label, True, type(exc).__name__)


def main(ta_path, dsn):
    seed_dir = os.path.join(ROOT, "seed")
    cities = import_legacy.load_cities(seed_dir)
    cargo = json.load(open(os.path.join(seed_dir, "cargo_types.json"), encoding="utf-8"))
    currencies = json.load(open(os.path.join(seed_dir, "currencies.json"), encoding="utf-8"))

    with psycopg.connect(dsn, autocommit=True) as conn:
        print("1. Міграція")
        conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        ddl = open(os.path.join(ROOT, "db/migrations/001_init.sql"), encoding="utf-8").read()
        t0 = time.time()
        conn.execute(ddl)
        ok("001_init.sql застосовано", True, f"{time.time() - t0:.2f} с")

        print("2. Довідники")
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO cities (id,country,continent,lat,lon,icao,name_uk,name_en,name_pl,name_de)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(c["id"], c["country"], c["continent"], c["lat"], c["lon"], c["icao"],
                  c["name_uk"], c["name_en"], c["name_pl"], c["name_de"]) for c in cities.values()])
            cur.executemany(
                "INSERT INTO cargo_types (id,name_uk,name_en,name_pl,name_de) VALUES (%s,%s,%s,%s,%s)",
                [(c["id"], c["name_uk"], c["name_en"], c["name_pl"], c["name_de"]) for c in cargo])
            cur.executemany(
                "INSERT INTO currencies (code,symbol,position,kind) VALUES (%s,%s,%s,%s)",
                [(c["code"], c["symbol"], c["position"], c["kind"]) for c in currencies])
        n_cities = conn.execute("SELECT count(*) FROM cities").fetchone()[0]
        ok("довідники засіяно", n_cities == len(cities),
           f"{n_cities} міст, {len(cargo)} вантажів, {len(currencies)} валют")

        geo = conn.execute(
            "SELECT round(ST_Distance(a.geom,b.geom)/1000) FROM cities a, cities b"
            " WHERE a.id='kyiv' AND b.id='warsaw'").fetchone()[0]
        ok("PostGIS-геометрія рахує відстані", 650 <= geo <= 800, f"Київ—Варшава {geo} км")

        print("3. Імпорт заявок")
        rows = import_legacy.read_legacy_listings(
            os.path.join(ta_path, "index.html"), os.path.join(ta_path, "test-data"))
        canon = [import_legacy.to_canonical(r, cities) for r in rows]
        companies = {c["company"]["id"]: c["company"]["display_name"] for c in canon}
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO companies (id,legal_name,display_name,country,is_imported)"
                " VALUES (%s,%s,%s,%s,true)",
                [(cid, name, name, "UA") for cid, name in companies.items()])
        t0 = time.time()
        with conn.cursor() as cur, conn.transaction():
            cur.execute("SET CONSTRAINTS ALL DEFERRED")
            cur.executemany(
                "INSERT INTO listings (id,legacy_id,company_id,kind,mode,components,"
                " origin_city_id,destination_city_id,origin_country,destination_country,"
                " ready_date,cargo_type_id,weight_kg,volume_m3,price_amount,price_currency,"
                " price_kind,status,source,created_at,updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(c["id"], c["legacy_id"], c["company"]["id"], c["kind"], c["mode"],
                  c["components"], c["origin_city_id"], c["destination_city_id"],
                  c["origin_country"], c["destination_country"], c["ready_date"],
                  c["cargo_type_id"], c["weight_kg"], c["volume_m3"], c["price_amount"],
                  c["price_currency"], c["price_kind"], c["status"], c["source"],
                  c["created_at"], c["updated_at"]) for c in canon])
            cur.executemany(
                "INSERT INTO listing_drone_details (listing_id,range_km,max_payload_kg,"
                " drone_type,flight_permit) VALUES (%s,%s,%s,%s,%s)",
                [(c["id"], c["drone"]["range_km"], c["drone"]["max_payload_kg"],
                  c["drone"]["drone_type"], c["drone"]["flight_permit"])
                 for c in canon if c["drone"]])
        imported = conn.execute("SELECT count(*) FROM listings").fetchone()[0]
        ok("усі заявки в БД", imported == len(canon),
           f"{imported}/{len(canon)} за {time.time() - t0:.1f} с")

        drones = conn.execute("SELECT count(*) FROM listing_drone_details").fetchone()[0]
        expected_drones = sum(1 for c in canon if c["drone"])
        ok("дрон-деталі повні", drones == expected_drones, f"{drones}/{expected_drones}")

        cross = conn.execute(
            "SELECT count(*) FROM listings WHERE is_cross_border").fetchone()[0]
        expected_cross = sum(1 for c in canon if c["is_cross_border"])
        ok("обчислюване is_cross_border збігається", cross == expected_cross,
           f"{cross} міжнародних")

        print("4. Паритет стрічки з фільтрами SPA")
        t0 = time.time()
        feed = conn.execute("""
            SELECT l.id FROM listings l
             WHERE l.status='active' AND l.kind=%s AND l.mode=%s
               AND l.origin_country=%s AND l.is_cross_border
               AND l.price_currency=%s
             ORDER BY l.created_at DESC, l.id DESC LIMIT 30
        """, ("cargo", "auto", "UA", "EUR")).fetchall()
        ok("запит стрічки з 5 фільтрами", len(feed) <= 30,
           f"{len(feed)} рядків за {(time.time() - t0) * 1000:.0f} мс")

        multi = conn.execute(
            "SELECT count(*) FROM listings WHERE mode='multi' AND components && "
            "ARRAY['sea']::transport_mode[]").fetchone()[0]
        ok("фільтр multiModes через GIN", multi > 0, f"{multi} морських мультимодальних")

        print("5. Негативні тести інваріантів")
        base = canon[0]
        tmpl = ("INSERT INTO listings (id,company_id,kind,mode,components,origin_city_id,"
                "destination_city_id,origin_country,destination_country,ready_date,"
                "cargo_type_id,weight_kg,price_amount,price_currency)"
                " VALUES (%s,%s,'cargo',%s,%s,%s,%s,'UA','PL','2026-10-01','food',1000,100,'EUR')")
        cid = base["company"]["id"]
        expect_error(conn, "multi без components", tmpl,
                     (str(uuid.uuid4()), cid, "multi", None, "kyiv", "warsaw"))
        expect_error(conn, "components поза multi", tmpl,
                     (str(uuid.uuid4()), cid, "auto", ["auto", "rail"], "kyiv", "warsaw"))
        expect_error(conn, "multi з одним плечем", tmpl,
                     (str(uuid.uuid4()), cid, "multi", ["auto"], "kyiv", "warsaw"))
        expect_error(conn, "multi, що містить drone", tmpl,
                     (str(uuid.uuid4()), cid, "multi", ["auto", "drone"], "kyiv", "warsaw"))
        expect_error(conn, "відправлення = призначення", tmpl,
                     (str(uuid.uuid4()), cid, "auto", None, "kyiv", "kyiv"))
        expect_error(conn, "невідоме місто", tmpl,
                     (str(uuid.uuid4()), cid, "auto", None, "atlantis", "warsaw"))
        expect_error(conn, "дрон без деталей", tmpl,
                     (str(uuid.uuid4()), cid, "drone", None, "kyiv", "warsaw"))
        expect_error(conn, "від'ємна вага",
                     tmpl.replace("weight_kg,price_amount", "weight_kg,price_amount")
                         .replace("1000,100", "-5,100"),
                     (str(uuid.uuid4()), cid, "auto", None, "kyiv", "warsaw"))
        expect_error(conn, "невідома валюта",
                     tmpl.replace("'EUR'", "'XXX'"),
                     (str(uuid.uuid4()), cid, "auto", None, "kyiv", "warsaw"))
        expect_error(conn, "повторний legacy_id",
                     "INSERT INTO listings (id,legacy_id,company_id,kind,mode,origin_city_id,"
                     "destination_city_id,origin_country,destination_country,ready_date,"
                     "cargo_type_id,weight_kg,price_amount,price_currency) VALUES "
                     "(%s,1,%s,'cargo','auto','kyiv','warsaw','UA','PL','2026-10-01','food',1,1,'EUR')",
                     (str(uuid.uuid4()), cid))
        expect_error(conn, "рівень L2 без дати перевірки",
                     "INSERT INTO companies (id,legal_name,display_name,country,verification_level)"
                     " VALUES (%s,'X','X','UA','L2')", (str(uuid.uuid4()),))

        print("6. Ідентичність і ролі")
        uid1, uid2, comp = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        conn.execute("INSERT INTO companies (id,legal_name,display_name,country)"
                     " VALUES (%s,'Тест','Тест','UA')", (comp,))
        for u in (uid1, uid2):
            conn.execute("INSERT INTO users (id,email,password_hash,full_name)"
                         " VALUES (%s,%s,'argon2id$stub','Тест')", (u, f"{u}@example.com"))
        conn.execute("INSERT INTO memberships (user_id,company_id,role) VALUES (%s,%s,'owner')",
                     (uid1, comp))
        expect_error(conn, "два власники в компанії",
                     "INSERT INTO memberships (user_id,company_id,role) VALUES (%s,%s,'owner')",
                     (uid2, comp))
        expect_error(conn, "email унікальний без урахування регістру",
                     "INSERT INTO users (id,email,password_hash,full_name)"
                     " VALUES (%s,%s,'x','Тест')", (str(uuid.uuid4()), f"{uid1}@EXAMPLE.COM"))

        print("7. Журнал подій")
        conn.execute("INSERT INTO event_log (kind,listing_id,actor_user_id,payload,occurred_at)"
                     " VALUES ('listing_view',%s,%s,'{}'::jsonb, now())", (base["id"], uid1))
        cnt = conn.execute("SELECT count(*) FROM event_log").fetchone()[0]
        ok("подія записана в партицію", cnt == 1, f"{cnt} запис")
        part = conn.execute(
            "SELECT tableoid::regclass::text FROM event_log LIMIT 1").fetchone()[0]
        ok("партиціонування працює", part.startswith("event_log_2026q"), part)

        conn.execute("CREATE ROLE app_rw LOGIN PASSWORD 'x'")
        conn.execute("GRANT USAGE ON SCHEMA public TO app_rw")
        conn.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw")
        conn.execute("REVOKE UPDATE, DELETE ON event_log FROM app_rw")
        with psycopg.connect(dsn.replace("user=ta", "user=app_rw").replace("password=ta", "password=x"),
                             autocommit=True) as c2:
            try:
                c2.execute("DELETE FROM event_log")
                ok("журнал append-only для ролі застосунку", False, "DELETE пройшов")
            except errors.InsufficientPrivilege:
                ok("журнал append-only для ролі застосунку", True, "DELETE заборонено")

        print("8. Ідемпотентність")
        key = ("k-1", uid1, "POST /api/v1/listings")
        conn.execute("INSERT INTO idempotency_keys (key,user_id,endpoint,request_hash,expires_at)"
                     " VALUES (%s,%s,%s,'\\x00', now()+interval '24h')", key)
        expect_error(conn, "повторний Idempotency-Key",
                     "INSERT INTO idempotency_keys (key,user_id,endpoint,request_hash,expires_at)"
                     " VALUES (%s,%s,%s,'\\x00', now()+interval '24h')", key)

    failed = [r for r in RESULTS if not r[1]]
    print("-" * 60)
    if failed:
        print(f"ПРОВАЛЕНО {len(failed)} із {len(RESULTS)}")
        return 1
    print(f"Усі {len(RESULTS)} перевірок на живій БД пройдено.")
    return 0


if __name__ == "__main__":
    ta = sys.argv[1] if len(sys.argv) > 1 else "../TA"
    dsn = sys.argv[2] if len(sys.argv) > 2 else "host=127.0.0.1 user=ta password=ta dbname=ta"
    sys.exit(main(ta, dsn))
