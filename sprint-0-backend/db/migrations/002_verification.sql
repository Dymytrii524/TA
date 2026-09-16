-- Trans-Atlas, міграція 002: модуль верифікації контрагентів.
-- Залежить від 001_init.sql (companies, users, event_log).
--
-- Принцип, який кодує ця схема: перевірка — це не оцінка, а зафіксований факт
-- із джерелом, датою і доказом. Відсутність відповіді джерела ніколи не
-- перетворюється на «пройдено»: для цього існує окремий статус unavailable.

BEGIN;

-- ============================================================ перерахування

-- Статус окремої перевірки. Порядок значень навмисний: unavailable стоїть
-- між attention і not_applicable, щоб випадкове сортування не робило його
-- «кращим» за pass.
CREATE TYPE check_status AS ENUM (
    'pass',           -- джерело відповіло, дані збігаються
    'attention',      -- джерело відповіло, є розбіжність або ризик, не блокує
    'fail',           -- джерело відповіло, підстава відмовити
    'unavailable',    -- джерело не відповіло або не покриває цей суб'єкт
    'not_applicable', -- перевірка не застосовна (напр. VIES для не-ЄС)
    'pending'         -- запит поставлено в чергу, відповіді ще немає
);

-- Тип verification_level уже створено в 001_init.sql і тут повторно не оголошується.

CREATE TYPE case_status AS ENUM (
    'draft',            -- заявник ще подає дані
    'awaiting_input',   -- потрібен документ або дія заявника
    'running',          -- перевірки виконуються
    'manual_review',    -- потрібне рішення оператора
    'approved',
    'rejected',
    'expired',
    'revoked'           -- рівень відкликано після моніторингу
);

CREATE TYPE source_kind AS ENUM (
    'state_registry',   -- держреєстр або його офіційне API
    'open_data',        -- вивантаження відкритих даних
    'commercial_api',   -- комерційний агрегатор
    'sanctions',
    'court',
    'tax',
    'manual'            -- документ, поданий заявником, перевірений оператором
);

-- Доступність джерела. Окрема сутність, бо статус перевірки не має
-- приховувати причину: «джерело мертве» і «компанію не знайдено» — різне.
CREATE TYPE source_health AS ENUM ('live', 'degraded', 'stale', 'down', 'manual_only');

CREATE TYPE identifier_kind AS ENUM (
    'edrpou',    -- UA, 8 цифр (юрособа) або РНОКПП ФОП
    'vat_eu',    -- ЄС, VIES
    'nip',       -- PL
    'regon',     -- PL
    'krs',       -- PL
    'lei',       -- глобальний
    'other'
);

CREATE TYPE requisite_kind AS ENUM (
    'legal_name', 'legal_address', 'status', 'director', 'beneficiary',
    'kved', 'bank_account', 'phone', 'email', 'website', 'capital'
);

-- ======================================================= каталог джерел

CREATE TABLE verification_sources (
    id              text PRIMARY KEY,          -- напр. 'vies', 'edr_nais', 'pl_white_list'
    title           text NOT NULL,
    kind            source_kind NOT NULL,
    jurisdiction    text NOT NULL,             -- ISO 3166-1 alpha-2 або 'EU', 'XX' (глобальне)
    endpoint        text,
    docs_url        text,
    requires_key    boolean NOT NULL DEFAULT false,
    cost_model      text,                      -- 'free' | 'per_query' | 'subscription'
    health          source_health NOT NULL DEFAULT 'live',
    health_checked_at timestamptz,
    -- Скільки відповідь джерела вважається свіжою. Після цього перевірка
    -- показується як застаріла і потребує повтору.
    ttl_days        integer NOT NULL CHECK (ttl_days > 0),
    -- Чи можна ухвалювати позитивне рішення, коли джерело недоступне.
    blocking        boolean NOT NULL DEFAULT false,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sources_jurisdiction_fmt CHECK (jurisdiction ~ '^[A-Z]{2}$'),
    -- Джерело, від якого залежить рішення, не може бути «тільки вручну».
    CONSTRAINT sources_blocking_needs_automation
        CHECK (NOT blocking OR health <> 'manual_only')
);

-- =================================================== каталог перевірок

CREATE TABLE verification_checks_catalog (
    id              text PRIMARY KEY,          -- 'identity.registry_match'
    title           text NOT NULL,
    source_id       text NOT NULL REFERENCES verification_sources(id),
    required_for    verification_level NOT NULL,
    -- fail цієї перевірки унеможливлює рівень
    is_decisive     boolean NOT NULL DEFAULT false,
    -- Перевірка застосовна лише до цих юрисдикцій; NULL = до всіх
    jurisdictions   text[],
    description     text NOT NULL,
    CONSTRAINT catalog_decisive_requires_level
        CHECK (NOT is_decisive OR required_for <> 'L0')
);

-- ====================================================== ідентифікатори

CREATE TABLE company_identifiers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind            identifier_kind NOT NULL,
    value           text NOT NULL,
    country         text NOT NULL,
    -- Підтверджений означає: знайдено у відповідному реєстрі, доказ збережено.
    confirmed_at    timestamptz,
    confirmed_by_check_id uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT identifiers_country_fmt CHECK (country ~ '^[A-Z]{2}$'),
    CONSTRAINT identifiers_edrpou_fmt
        CHECK (kind <> 'edrpou' OR value ~ '^[0-9]{8}$' OR value ~ '^[0-9]{10}$'),
    CONSTRAINT identifiers_nip_fmt CHECK (kind <> 'nip' OR value ~ '^[0-9]{10}$'),
    CONSTRAINT identifiers_krs_fmt CHECK (kind <> 'krs' OR value ~ '^[0-9]{10}$'),
    CONSTRAINT identifiers_vat_fmt CHECK (kind <> 'vat_eu' OR value ~ '^[A-Z]{2}[A-Za-z0-9]{2,12}$')
);

-- Один і той самий ідентифікатор не може належати двом компаніям.
CREATE UNIQUE INDEX company_identifiers_unique
    ON company_identifiers (kind, value) WHERE confirmed_at IS NOT NULL;
CREATE INDEX company_identifiers_company ON company_identifiers (company_id);

-- ====================================================== справи перевірки

CREATE TABLE verification_cases (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    target_level    verification_level NOT NULL,
    status          case_status NOT NULL DEFAULT 'draft',
    requested_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at      timestamptz,
    decision_reason text,
    -- Рівень діє обмежений час; після expires_at компанія падає на L0,
    -- поки не пройде повторну перевірку.
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cases_target_not_l0 CHECK (target_level <> 'L0'),
    -- Рішення завжди має автора і час: автоматичне схвалення теж пишеться
    -- від імені системного користувача.
    CONSTRAINT cases_decision_complete CHECK (
        (status IN ('approved','rejected','revoked')) = (decided_at IS NOT NULL)
    ),
    CONSTRAINT cases_rejection_needs_reason CHECK (
        status NOT IN ('rejected','revoked') OR decision_reason IS NOT NULL
    ),
    CONSTRAINT cases_approved_needs_expiry CHECK (
        status <> 'approved' OR expires_at IS NOT NULL
    )
);

-- Одна активна справа на компанію: паралельні заявки створюють плутанину
-- і подвійні витрати на платні джерела.
CREATE UNIQUE INDEX verification_cases_one_active
    ON verification_cases (company_id)
    WHERE status IN ('draft','awaiting_input','running','manual_review');

CREATE INDEX verification_cases_status ON verification_cases (status, created_at DESC);

-- ================================================= результати перевірок

CREATE TABLE verification_check_results (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id         uuid NOT NULL REFERENCES verification_cases(id) ON DELETE CASCADE,
    check_id        text NOT NULL REFERENCES verification_checks_catalog(id),
    source_id       text NOT NULL REFERENCES verification_sources(id),
    status          check_status NOT NULL,
    -- Що саме звірялося і що відповіло джерело. Нормалізований зріз,
    -- не сирий відгук: сирий лежить у verification_evidence.
    subject         jsonb NOT NULL,
    findings        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Причина, якщо статус не pass. Обов'язкова: «просто не пройшло» не є
    -- відповіддю ані для оператора, ані для заявника.
    reason_code     text,
    reason_text     text,
    requested_at    timestamptz NOT NULL DEFAULT now(),
    responded_at    timestamptz,
    valid_until     timestamptz,
    latency_ms      integer CHECK (latency_ms >= 0),
    cost_micro      bigint NOT NULL DEFAULT 0 CHECK (cost_micro >= 0), -- 1e-6 EUR
    attempt         integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    CONSTRAINT results_nonpass_needs_reason
        CHECK (status IN ('pass','pending') OR reason_code IS NOT NULL),
    CONSTRAINT results_answer_needs_time
        CHECK (status = 'pending' OR responded_at IS NOT NULL),
    -- Успішна відповідь мусить мати строк дії, інакше застаріле pass
    -- лишається чинним назавжди.
    CONSTRAINT results_pass_needs_validity
        CHECK (status NOT IN ('pass','attention') OR valid_until IS NOT NULL),
    -- Недоступне джерело не має права нести знахідки: порожній об'єкт
    -- унеможливлює тихе перетворення unavailable на pass у звітах.
    CONSTRAINT results_unavailable_has_no_findings
        CHECK (status <> 'unavailable' OR findings = '{}'::jsonb)
);

CREATE INDEX check_results_case ON verification_check_results (case_id);
CREATE INDEX check_results_status ON verification_check_results (status, requested_at DESC);
CREATE UNIQUE INDEX check_results_case_check_attempt
    ON verification_check_results (case_id, check_id, attempt);

-- ============================================================== докази

-- Незмінний доказ: точний відгук джерела на момент запиту.
-- Потрібен, щоб через рік можна було довести, що саме показував реєстр.
CREATE TABLE verification_evidence (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    result_id       uuid NOT NULL REFERENCES verification_check_results(id) ON DELETE RESTRICT,
    source_id       text NOT NULL REFERENCES verification_sources(id),
    -- SHA-256 сирого тіла відповіді. Дає змогу довести незмінність,
    -- не тримаючи персональні дані в індексі.
    payload_sha256  bytea NOT NULL,
    payload_size    integer NOT NULL CHECK (payload_size >= 0),
    content_type    text NOT NULL,
    storage_uri     text NOT NULL,          -- об'єктне сховище, WORM-бакет
    http_status     integer,
    fetched_at      timestamptz NOT NULL,
    -- Дата стану даних у джерелі, якщо воно її повідомляє (KRS: stanZDnia,
    -- відкриті дані: дата вивантаження). Відрізняється від fetched_at і
    -- саме вона визначає фактичну свіжість.
    source_as_of    date,
    retention_until date NOT NULL,
    CONSTRAINT evidence_sha_len CHECK (octet_length(payload_sha256) = 32)
);

CREATE UNIQUE INDEX evidence_result_unique ON verification_evidence (result_id);
CREATE INDEX evidence_retention ON verification_evidence (retention_until);

-- ============================================ реквізити та їх зміни

-- Поточний знімок реквізитів компанії за даними джерела.
CREATE TABLE company_requisites (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind            requisite_kind NOT NULL,
    value           text NOT NULL,
    value_norm      text NOT NULL,      -- нормалізоване для порівняння
    source_id       text NOT NULL REFERENCES verification_sources(id),
    observed_at     timestamptz NOT NULL DEFAULT now(),
    superseded_at   timestamptz,
    CONSTRAINT requisites_period CHECK (superseded_at IS NULL OR superseded_at >= observed_at)
);

-- Для кожного виду реквізиту з кожного джерела чинним може бути лише
-- один запис. Це і робить порівняння дельти однозначним.
CREATE UNIQUE INDEX company_requisites_current
    ON company_requisites (company_id, kind, source_id, value_norm)
    WHERE superseded_at IS NULL;
CREATE INDEX company_requisites_company ON company_requisites (company_id, kind);

CREATE TYPE change_severity AS ENUM ('info', 'attention', 'critical');

-- Виявлена зміна реквізиту. Саме це — товар, за який на цьому ринку
-- платять: не разова довідка, а сигнал «щось змінилося вчора».
CREATE TABLE requisite_changes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind            requisite_kind NOT NULL,
    old_value       text,
    new_value       text,
    source_id       text NOT NULL REFERENCES verification_sources(id),
    severity        change_severity NOT NULL,
    detected_at     timestamptz NOT NULL DEFAULT now(),
    notified_at     timestamptz,
    -- Наслідок для рівня: зміна банківського рахунку або директора
    -- призупиняє L2 до підтвердження.
    suspends_level  boolean NOT NULL DEFAULT false,
    CONSTRAINT changes_something_changed
        CHECK (old_value IS DISTINCT FROM new_value),
    -- Критична зміна зобов'язана мати наслідок, інакше severity — прикраса.
    CONSTRAINT changes_critical_suspends
        CHECK (severity <> 'critical' OR suspends_level)
);

CREATE INDEX requisite_changes_company ON requisite_changes (company_id, detected_at DESC);
CREATE INDEX requisite_changes_unnotified
    ON requisite_changes (detected_at) WHERE notified_at IS NULL;

-- ==================================================== моніторинг

CREATE TABLE monitoring_subscriptions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_id       text NOT NULL REFERENCES verification_sources(id),
    interval_hours  integer NOT NULL CHECK (interval_hours BETWEEN 1 AND 8760),
    next_run_at     timestamptz NOT NULL DEFAULT now(),
    last_run_at     timestamptz,
    last_status     check_status,
    consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    is_active       boolean NOT NULL DEFAULT true,
    UNIQUE (company_id, source_id)
);

CREATE INDEX monitoring_due ON monitoring_subscriptions (next_run_at)
    WHERE is_active;

-- ================================================ санкції та суди

CREATE TABLE sanction_hits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_id       text NOT NULL REFERENCES verification_sources(id),
    list_name       text NOT NULL,
    subject_name    text NOT NULL,
    match_score     numeric(4,3) NOT NULL CHECK (match_score BETWEEN 0 AND 1),
    -- Збіг за назвою — гіпотеза, а не факт. Поки оператор не підтвердив,
    -- рішення ухвалює людина.
    is_confirmed    boolean,
    reviewed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     timestamptz,
    external_ref    text,
    detected_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sanction_review_complete
        CHECK ((is_confirmed IS NULL) = (reviewed_at IS NULL)),
    CONSTRAINT sanction_review_has_author
        CHECK (reviewed_at IS NULL OR reviewed_by IS NOT NULL)
);

CREATE INDEX sanction_hits_company ON sanction_hits (company_id, detected_at DESC);
CREATE INDEX sanction_hits_unreviewed ON sanction_hits (detected_at)
    WHERE is_confirmed IS NULL;

CREATE TYPE court_role AS ENUM ('defendant', 'plaintiff', 'third_party', 'unknown');

CREATE TABLE court_case_hits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_id       text NOT NULL REFERENCES verification_sources(id),
    case_number     text NOT NULL,
    court_name      text,
    role            court_role NOT NULL DEFAULT 'unknown',
    category        text,                      -- 'bankruptcy', 'debt', 'tax', ...
    decision_date   date,
    doc_url         text,
    amount_eur      numeric(16,2),
    is_relevant     boolean,
    detected_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (company_id, case_number)
);

CREATE INDEX court_hits_company ON court_case_hits (company_id, decision_date DESC);

-- ====================================== історія рівнів (append-only)

CREATE TABLE verification_level_history (
    id              bigint GENERATED ALWAYS AS IDENTITY,
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    old_level       verification_level,
    new_level       verification_level NOT NULL,
    case_id         uuid REFERENCES verification_cases(id) ON DELETE SET NULL,
    change_id       uuid REFERENCES requisite_changes(id) ON DELETE SET NULL,
    reason          text NOT NULL,
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    changed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (changed_at, id),
    CONSTRAINT level_history_actual_change CHECK (old_level IS DISTINCT FROM new_level)
) PARTITION BY RANGE (changed_at);

CREATE TABLE verification_level_history_2026 PARTITION OF verification_level_history
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE verification_level_history_2027 PARTITION OF verification_level_history
    FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');

-- ======================================= розширення таблиці компаній

ALTER TABLE companies
    ADD COLUMN verification_case_id uuid REFERENCES verification_cases(id) ON DELETE SET NULL,
    ADD COLUMN verification_expires_at timestamptz,
    ADD COLUMN verification_suspended_at timestamptz,
    ADD COLUMN verification_suspend_reason text;

-- Призупинення завжди має причину.
ALTER TABLE companies ADD CONSTRAINT companies_suspend_has_reason
    CHECK ((verification_suspended_at IS NULL) = (verification_suspend_reason IS NULL));

-- ================================================ правила рівня

-- Рівень вище L0 не може бути виставлений без справи, яка його дала.
CREATE OR REPLACE FUNCTION check_level_has_case() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.verification_level <> 'L0' AND NEW.verification_case_id IS NULL THEN
        RAISE EXCEPTION 'рівень % без справи верифікації', NEW.verification_level
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.verification_level <> 'L0' AND NEW.verification_expires_at IS NULL THEN
        RAISE EXCEPTION 'рівень % без строку дії', NEW.verification_level
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER companies_level_needs_case
    BEFORE INSERT OR UPDATE OF verification_level, verification_case_id ON companies
    FOR EACH ROW EXECUTE FUNCTION check_level_has_case();

-- Кожна зміна рівня потрапляє в історію автоматично: покластися на код
-- застосунку тут не можна, бо рівень міняють щонайменше троє —
-- оператор, планувальник моніторингу і процес закінчення строку.
CREATE OR REPLACE FUNCTION log_level_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.verification_level IS DISTINCT FROM OLD.verification_level THEN
        INSERT INTO verification_level_history
            (company_id, old_level, new_level, case_id, reason)
        VALUES (NEW.id, OLD.verification_level, NEW.verification_level,
                NEW.verification_case_id,
                coalesce(NEW.verification_suspend_reason, 'зміна рівня'));
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER companies_level_history
    AFTER UPDATE OF verification_level ON companies
    FOR EACH ROW EXECUTE FUNCTION log_level_change();

-- ================================================ доступ до даних

-- Публічне досьє: те, що бачить будь-який авторизований користувач.
-- Персональні дані (директор, бенефіціар, телефон) навмисно виключені —
-- вони доступні лише в межах справи і кожен показ журналюється.
CREATE VIEW company_public_dossier AS
SELECT
    c.id,
    c.display_name,
    c.country,
    c.verification_level,
    c.verification_expires_at,
    (c.verification_suspended_at IS NOT NULL) AS is_suspended,
    (SELECT count(*) FROM sanction_hits s
      WHERE s.company_id = c.id AND s.is_confirmed) AS confirmed_sanction_hits,
    (SELECT count(*) FROM court_case_hits h
      WHERE h.company_id = c.id AND h.is_relevant
        AND h.decision_date > current_date - 1095) AS relevant_court_cases,
    (SELECT max(r.detected_at) FROM requisite_changes r
      WHERE r.company_id = c.id AND r.severity <> 'info') AS last_material_change_at
FROM companies c;

COMMIT;
