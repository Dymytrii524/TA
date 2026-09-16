#!/usr/bin/env python3
"""Приймальні тести модуля верифікації на живому PostgreSQL.

Перевіряє не опис, а поведінку: чи справді база не дає видати рівень без
справи, чи справді unavailable не стає pass, чи справді зміна банківського
рахунку призупиняє рівень, і чи потрапляє кожна зміна рівня в історію без
участі коду застосунку.

Запуск: python3 ci/acceptance_verification_db.py [dsn]
"""
import json
import os
import sys
import uuid

import psycopg
from psycopg import errors

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RESULTS = []
NOW = "now()"


def ok(label, passed, detail=""):
    RESULTS.append((label, passed, detail))
    print(f"  [{'ok' if passed else 'ПРОВАЛ'}] {label}" + (f" — {detail}" if detail else ""))


def expect_error(conn, label, sql, params=None):
    try:
        with conn.transaction():
            conn.execute(sql, params or ())
        ok(label, False, "операція пройшла, хоча мала впасти")
    except (errors.IntegrityError, errors.RaiseException, errors.InsufficientPrivilege,
            errors.DataError) as exc:
        ok(label, True, type(exc).__name__)


def main(dsn):
    src = json.load(open(os.path.join(ROOT, "seed/verification_sources.json"), encoding="utf-8"))
    cat = json.load(open(os.path.join(ROOT, "seed/verification_checks.json"), encoding="utf-8"))

    with psycopg.connect(dsn, autocommit=True) as conn:
        print("1. Міграції")
        conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        for name in ("001_init.sql", "002_verification.sql"):
            conn.execute(open(os.path.join(ROOT, "db/migrations", name),
                              encoding="utf-8").read())
        ok("001 і 002 застосовано послідовно", True)

        print("2. Каталоги")
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO verification_sources (id,title,kind,jurisdiction,endpoint,"
                "docs_url,requires_key,cost_model,health,ttl_days,blocking,notes)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(s["id"], s["title"], s["kind"], s["jurisdiction"], s.get("endpoint"),
                  s.get("docs_url"), s["requires_key"], s["cost_model"],
                  s.get("health", "live"), s["ttl_days"], s["blocking"], s.get("notes"))
                 for s in src])
            cur.executemany(
                "INSERT INTO verification_checks_catalog (id,title,source_id,required_for,"
                "is_decisive,jurisdictions,description) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                [(c["id"], c["title"], c["source_id"], c["required_for"], c["is_decisive"],
                  c.get("jurisdictions"), c["description"]) for c in cat])
        n = conn.execute("SELECT count(*) FROM verification_sources").fetchone()[0]
        m = conn.execute("SELECT count(*) FROM verification_checks_catalog").fetchone()[0]
        ok("каталоги завантажено без правок", n == len(src) and m == len(cat),
           f"{n} джерел, {m} перевірок")

        expect_error(conn, "блокуюче джерело не може бути суто ручним",
                     "INSERT INTO verification_sources (id,title,kind,jurisdiction,"
                     "requires_key,ttl_days,blocking,health) VALUES "
                     "('x','X','manual','UA',false,30,true,'manual_only')")

        print("3. Підготовка компанії")
        comp, user = str(uuid.uuid4()), str(uuid.uuid4())
        conn.execute("INSERT INTO companies (id,legal_name,display_name,country)"
                     " VALUES (%s,'ТОВ Перевізник','Перевізник','UA')", (comp,))
        conn.execute("INSERT INTO users (id,email,password_hash,full_name)"
                     " VALUES (%s,'op@example.com','argon2id$stub','Оператор')", (user,))
        conn.execute("INSERT INTO company_identifiers (company_id,kind,value,country,"
                     "confirmed_at) VALUES (%s,'edrpou','12345678','UA', now())", (comp,))
        ok("ідентифікатор підтверджено", True)

        expect_error(conn, "ЄДРПОУ неправильного формату",
                     "INSERT INTO company_identifiers (company_id,kind,value,country)"
                     " VALUES (%s,'edrpou','12AB','UA')", (comp,))
        comp2 = str(uuid.uuid4())
        conn.execute("INSERT INTO companies (id,legal_name,display_name,country)"
                     " VALUES (%s,'ТОВ Двійник','Двійник','UA')", (comp2,))
        expect_error(conn, "один код не належить двом компаніям",
                     "INSERT INTO company_identifiers (company_id,kind,value,country,"
                     "confirmed_at) VALUES (%s,'edrpou','12345678','UA', now())", (comp2,))

        print("4. Справа верифікації")
        case = str(uuid.uuid4())
        conn.execute("INSERT INTO verification_cases (id,company_id,target_level,status,"
                     "requested_by) VALUES (%s,%s,'L1','running',%s)", (case, comp, user))
        expect_error(conn, "друга активна справа на компанію",
                     "INSERT INTO verification_cases (company_id,target_level,status)"
                     " VALUES (%s,'L1','running')", (comp,))
        expect_error(conn, "справа на рівень L0",
                     "INSERT INTO verification_cases (company_id,target_level,status)"
                     " VALUES (%s,'L0','draft')", (comp2,))
        expect_error(conn, "схвалення без строку дії",
                     "INSERT INTO verification_cases (company_id,target_level,status,"
                     "decided_at) VALUES (%s,'L1','approved', now())", (comp2,))
        expect_error(conn, "відмова без причини",
                     "INSERT INTO verification_cases (company_id,target_level,status,"
                     "decided_at) VALUES (%s,'L1','rejected', now())", (comp2,))
        expect_error(conn, "схвалення без часу рішення",
                     "INSERT INTO verification_cases (company_id,target_level,status,"
                     "expires_at) VALUES (%s,'L1','approved', now()+interval '1 y')", (comp2,))

        print("5. Результати перевірок")
        res_pass = str(uuid.uuid4())
        conn.execute("""INSERT INTO verification_check_results
            (id,case_id,check_id,source_id,status,subject,findings,responded_at,valid_until,
             latency_ms) VALUES (%s,%s,'identity.vat_active','vies','pass',
             %s::jsonb,%s::jsonb, now(), now()+interval '30 days', 528)""",
                     (res_pass, case, json.dumps({"identifier_kind": "vat_eu"}),
                      json.dumps({"valid": True})))
        ok("успішний результат записано", True)

        expect_error(conn, "unavailable зі знахідками",
                     """INSERT INTO verification_check_results
            (case_id,check_id,source_id,status,subject,findings,reason_code,responded_at)
            VALUES (%s,'risk.sanctions_ua','drs_nsdc','unavailable','{}'::jsonb,
                    '{"valid": true}'::jsonb,'SOURCE_UNAUTHORIZED', now())""", (case,))
        expect_error(conn, "pass без строку дії",
                     """INSERT INTO verification_check_results
            (case_id,check_id,source_id,status,subject,responded_at)
            VALUES (%s,'identity.registry_match','edr_nais','pass','{}'::jsonb, now())""",
                     (case,))
        expect_error(conn, "fail без коду причини",
                     """INSERT INTO verification_check_results
            (case_id,check_id,source_id,status,subject,responded_at)
            VALUES (%s,'risk.bankruptcy','edr_nais','fail','{}'::jsonb, now())""", (case,))
        expect_error(conn, "завершений результат без часу відповіді",
                     """INSERT INTO verification_check_results
            (case_id,check_id,source_id,status,subject,reason_code)
            VALUES (%s,'risk.bankruptcy','edr_nais','attention','{}'::jsonb,'X')""", (case,))
        expect_error(conn, "повтор тієї самої спроби перевірки",
                     """INSERT INTO verification_check_results
            (case_id,check_id,source_id,status,subject,responded_at,valid_until)
            VALUES (%s,'identity.vat_active','vies','pass','{}'::jsonb, now(),
                    now()+interval '30 days')""", (case,))

        # Коректний запис недоступності: знахідок немає, причина є.
        conn.execute("""INSERT INTO verification_check_results
            (case_id,check_id,source_id,status,subject,reason_code,reason_text,responded_at)
            VALUES (%s,'risk.sanctions_ua','drs_nsdc','unavailable','{}'::jsonb,
                    'SOURCE_UNAUTHORIZED','джерело повернуло 401', now())""", (case,))
        ok("недоступність фіксується окремим статусом", True)

        print("6. Докази")
        conn.execute("""INSERT INTO verification_evidence
            (result_id,source_id,payload_sha256,payload_size,content_type,storage_uri,
             http_status,fetched_at,source_as_of,retention_until)
            VALUES (%s,'vies', decode(repeat('ab',32),'hex'), 512,'application/json',
                    's3://ta-evidence/2026/09/x.json',200, now(),'2026-09-10','2031-09-10')""",
                     (res_pass,))
        ok("доказ прив'язано до результату", True)
        expect_error(conn, "хеш доказу неправильної довжини",
                     """INSERT INTO verification_evidence
            (result_id,source_id,payload_sha256,payload_size,content_type,storage_uri,
             fetched_at,retention_until) VALUES (%s,'vies', decode('abab','hex'),1,'x','y',
             now(),'2031-01-01')""", (res_pass,))
        expect_error(conn, "результат із доказом не видаляється",
                     "DELETE FROM verification_check_results WHERE id = %s", (res_pass,))

        print("7. Схвалення і рівень")
        conn.execute("UPDATE verification_cases SET status='approved', decided_by=%s,"
                     " decided_at=now(), expires_at=now()+interval '365 days',"
                     " decision_reason='усі перевірки пройдено' WHERE id=%s", (user, case))
        expect_error(conn, "рівень без справи",
                     "UPDATE companies SET verification_level='L1', verified_at=now()"
                     " WHERE id=%s", (comp,))
        expect_error(conn, "рівень без строку дії",
                     "UPDATE companies SET verification_level='L1', verified_at=now(),"
                     " verification_case_id=%s WHERE id=%s", (case, comp))
        conn.execute("UPDATE companies SET verification_level='L1', verified_at=now(),"
                     " verification_case_id=%s, verification_expires_at=now()+interval '365 days'"
                     " WHERE id=%s", (case, comp))
        lvl = conn.execute("SELECT verification_level FROM companies WHERE id=%s",
                           (comp,)).fetchone()[0]
        ok("рівень L1 виставлено", lvl == "L1")

        hist = conn.execute("SELECT old_level,new_level FROM verification_level_history"
                            " WHERE company_id=%s", (comp,)).fetchall()
        ok("зміна рівня потрапила в історію без участі застосунку",
           hist == [("L0", "L1")], str(hist))

        print("8. Моніторинг і зміна реквізитів")
        conn.execute("INSERT INTO monitoring_subscriptions (company_id,source_id,"
                     "interval_hours) VALUES (%s,'pl_white_list',24)", (comp,))
        due = conn.execute("SELECT count(*) FROM monitoring_subscriptions"
                           " WHERE is_active AND next_run_at <= now()").fetchone()[0]
        ok("підписка потрапляє у чергу прогону", due == 1)
        expect_error(conn, "дві підписки на одне джерело",
                     "INSERT INTO monitoring_subscriptions (company_id,source_id,"
                     "interval_hours) VALUES (%s,'pl_white_list',24)", (comp,))
        expect_error(conn, "інтервал моніторингу поза межами",
                     "INSERT INTO monitoring_subscriptions (company_id,source_id,"
                     "interval_hours) VALUES (%s,'vies',0)", (comp,))

        acc = "PL11101010100000000000000000"
        conn.execute("INSERT INTO company_requisites (company_id,kind,value,value_norm,"
                     "source_id) VALUES (%s,'bank_account',%s,%s,'pl_white_list')",
                     (comp, acc, acc))
        # Новий прогін бачить інший рахунок: старий закривається, зміна фіксується.
        acc2 = "PL22202020200000000000000000"
        with conn.transaction():
            conn.execute("UPDATE company_requisites SET superseded_at=now()"
                         " WHERE company_id=%s AND kind='bank_account' AND superseded_at IS NULL",
                         (comp,))
            conn.execute("INSERT INTO company_requisites (company_id,kind,value,value_norm,"
                         "source_id) VALUES (%s,'bank_account',%s,%s,'pl_white_list')",
                         (comp, acc2, acc2))
            conn.execute("INSERT INTO requisite_changes (company_id,kind,old_value,new_value,"
                         "source_id,severity,suspends_level) VALUES "
                         "(%s,'bank_account',%s,%s,'pl_white_list','critical',true)",
                         (comp, acc, acc2))
        cur_acc = conn.execute("SELECT value FROM company_requisites WHERE company_id=%s"
                               " AND kind='bank_account' AND superseded_at IS NULL",
                               (comp,)).fetchall()
        ok("чинним лишається рівно один рахунок", cur_acc == [(acc2,)], str(cur_acc))

        expect_error(conn, "зміна, у якій нічого не змінилося",
                     "INSERT INTO requisite_changes (company_id,kind,old_value,new_value,"
                     "source_id,severity) VALUES (%s,'legal_name','А','А','edr_nais','info')",
                     (comp,))
        expect_error(conn, "критична зміна, що не призупиняє рівень",
                     "INSERT INTO requisite_changes (company_id,kind,old_value,new_value,"
                     "source_id,severity,suspends_level) VALUES "
                     "(%s,'director','А','Б','edr_nais','critical',false)", (comp,))

        print("9. Призупинення після критичної зміни")
        conn.execute("UPDATE companies SET verification_suspended_at=now(),"
                     " verification_suspend_reason='змінено банківський рахунок' WHERE id=%s",
                     (comp,))
        expect_error(conn, "призупинення без причини",
                     "UPDATE companies SET verification_suspended_at=now(),"
                     " verification_suspend_reason=NULL WHERE id=%s", (comp,))
        row = conn.execute("SELECT verification_level, is_suspended FROM company_public_dossier"
                           " WHERE id=%s", (comp,)).fetchone()
        ok("досьє показує призупинення, не приховуючи рівень",
           row == ("L1", True), str(row))

        print("10. Санкції та суди")
        conn.execute("INSERT INTO sanction_hits (company_id,source_id,list_name,subject_name,"
                     "match_score) VALUES (%s,'opensanctions','eu_fsf','ТОВ Перевізник',0.870)",
                     (comp,))
        unrev = conn.execute("SELECT count(*) FROM sanction_hits WHERE is_confirmed IS NULL"
                             ).fetchone()[0]
        ok("збіг за назвою чекає на людину, а не блокує сам", unrev == 1)
        expect_error(conn, "перевірений збіг без автора рішення",
                     "UPDATE sanction_hits SET is_confirmed=true, reviewed_at=now()"
                     " WHERE company_id=%s", (comp,))
        expect_error(conn, "оцінка збігу поза межами 0..1",
                     "INSERT INTO sanction_hits (company_id,source_id,list_name,subject_name,"
                     "match_score) VALUES (%s,'opensanctions','eu_fsf','X',1.5)", (comp,))
        conn.execute("INSERT INTO court_case_hits (company_id,source_id,case_number,category,"
                     "decision_date,is_relevant) VALUES "
                     "(%s,'edrsr','910/1234/26','bankruptcy','2026-03-01',true)", (comp,))
        dossier = conn.execute("SELECT confirmed_sanction_hits, relevant_court_cases"
                               " FROM company_public_dossier WHERE id=%s", (comp,)).fetchone()
        ok("непідтверджений збіг не потрапляє в публічне досьє",
           dossier == (0, 1), str(dossier))

        print("11. Права ролі застосунку")
        conn.execute("DROP ROLE IF EXISTS app_rw")
        conn.execute("CREATE ROLE app_rw LOGIN PASSWORD 'x'")
        conn.execute("GRANT USAGE ON SCHEMA public TO app_rw")
        conn.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public"
                     " TO app_rw")
        conn.execute("REVOKE UPDATE, DELETE ON verification_level_history FROM app_rw")
        conn.execute("REVOKE UPDATE, DELETE ON verification_evidence FROM app_rw")
        app_dsn = dsn.replace("user=ta", "user=app_rw").replace("password=ta", "password=x")
        with psycopg.connect(app_dsn, autocommit=True) as c2:
            for table in ("verification_level_history", "verification_evidence"):
                try:
                    c2.execute(f"DELETE FROM {table}")
                    ok(f"{table} не редагується застосунком", False, "DELETE пройшов")
                except errors.InsufficientPrivilege:
                    ok(f"{table} не редагується застосунком", True, "DELETE заборонено")
            cnt = c2.execute("SELECT count(*) FROM company_public_dossier").fetchone()[0]
            ok("публічне досьє читається роллю застосунку", cnt >= 1, f"{cnt} компаній")

        print("12. Закінчення строку дії")
        conn.execute("UPDATE verification_cases SET expires_at = now() - interval '1 day'"
                     " WHERE id=%s", (case,))
        expired = conn.execute(
            "SELECT count(*) FROM verification_cases WHERE status='approved'"
            " AND expires_at < now()").fetchone()[0]
        ok("прострочені справи знаходяться одним запитом", expired == 1)
        conn.execute("UPDATE companies SET verification_level='L0', verification_case_id=NULL,"
                     " verification_expires_at=NULL, verified_at=NULL WHERE id=%s", (comp,))
        hist = conn.execute("SELECT old_level,new_level FROM verification_level_history"
                            " WHERE company_id=%s ORDER BY changed_at, id", (comp,)).fetchall()
        ok("падіння на L0 теж потрапило в історію",
           hist == [("L0", "L1"), ("L1", "L0")], str(hist))

    failed = [r for r in RESULTS if not r[1]]
    print("-" * 60)
    if failed:
        print(f"ПРОВАЛЕНО {len(failed)} із {len(RESULTS)}")
        return 1
    print(f"Усі {len(RESULTS)} перевірок на живій БД пройдено.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1
                  else "host=127.0.0.1 user=ta password=ta dbname=ta"))
