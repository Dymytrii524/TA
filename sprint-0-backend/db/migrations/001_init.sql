-- Trans-Atlas, Спринт 0: базова схема.
-- PostgreSQL 18 + PostGIS. Виконувати в порядку номерів файлів, у транзакції.
-- Правила: гроші — NUMERIC, ніколи double precision; час — timestamptz у UTC;
-- ідентифікатори сутностей — UUID v7 (генерується застосунком, не БД).

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- перерахування
-- Склад цих типів дослівно збігається з реєстрами SPA (index.html).
-- Перевірка E у ci/check_backend_contract.py падає при будь-якій розбіжності.
CREATE TYPE transport_mode      AS ENUM ('auto', 'rail', 'sea', 'air', 'multi', 'drone');
CREATE TYPE listing_kind        AS ENUM ('cargo', 'transport');
CREATE TYPE continent_code      AS ENUM ('europe', 'asia', 'africa', 'america', 'australia');
CREATE TYPE listing_status      AS ENUM ('draft', 'active', 'paused', 'expired', 'closed', 'removed');
CREATE TYPE listing_source      AS ENUM ('manual', 'import', 'ingest_email', 'ingest_file', 'ingest_bot', 'api');
CREATE TYPE price_kind          AS ENUM ('fixed', 'negotiable', 'request');
CREATE TYPE verification_level  AS ENUM ('L0', 'L1', 'L2');
CREATE TYPE user_role           AS ENUM ('owner', 'manager', 'viewer');
CREATE TYPE currency_kind       AS ENUM ('fiat', 'crypto');

-- ---------------------------------------------------------------- довідники
CREATE TABLE cities (
    id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]+$'),
    country     char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    continent   continent_code NOT NULL,
    lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon         double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
    icao        char(4),
    name_uk     text NOT NULL,
    name_en     text NOT NULL,
    name_pl     text,
    name_de     text,
    geom        geography(Point, 4326) GENERATED ALWAYS AS
                (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED
);
CREATE INDEX cities_geom_idx      ON cities USING gist (geom);
CREATE INDEX cities_country_idx   ON cities (country);
CREATE INDEX cities_continent_idx ON cities (continent);

CREATE TABLE cargo_types (
    id      text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]+$'),
    name_uk text NOT NULL,
    name_en text NOT NULL,
    name_pl text,
    name_de text
);

CREATE TABLE currencies (
    code      text PRIMARY KEY CHECK (code ~ '^[A-Z]{3,4}$'),
    symbol    text NOT NULL,
    position  text NOT NULL CHECK (position IN ('pre', 'post')),
    kind      currency_kind NOT NULL,
    is_active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- компанії й користувачі
CREATE TABLE companies (
    id                 uuid PRIMARY KEY,
    legal_name         text NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 200),
    display_name       text NOT NULL,
    country            char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    tax_id             text,
    verification_level verification_level NOT NULL DEFAULT 'L0',
    verified_at        timestamptz,
    is_imported        boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Рівень вище L0 без дати перевірки неможливий: значок завжди має джерело й дату.
    CONSTRAINT companies_verified_needs_date
        CHECK (verification_level = 'L0' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX companies_tax_id_uidx ON companies (country, tax_id) WHERE tax_id IS NOT NULL;
CREATE INDEX companies_name_trgm_idx ON companies USING gin (display_name gin_trgm_ops);

CREATE TABLE users (
    id             uuid PRIMARY KEY,
    email          citext NOT NULL UNIQUE,
    password_hash  text NOT NULL,           -- argon2id, включно з параметрами
    full_name      text NOT NULL,
    phone          text,
    locale         text NOT NULL DEFAULT 'uk',
    email_verified boolean NOT NULL DEFAULT false,
    failed_logins  integer NOT NULL DEFAULT 0,
    locked_until   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role       user_role NOT NULL DEFAULT 'owner',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, company_id)
);
-- У кожної компанії рівно один власник.
CREATE UNIQUE INDEX memberships_single_owner_uidx
    ON memberships (company_id) WHERE role = 'owner';

CREATE TABLE refresh_tokens (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  bytea NOT NULL UNIQUE,      -- зберігається лише SHA-256 від токена
    family_id   uuid NOT NULL,              -- ротація: повторне використання вбиває всю сім'ю
    issued_at   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    user_agent  text,
    ip          inet
);
CREATE INDEX refresh_tokens_user_idx   ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE email_tokens (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- заявки
CREATE TABLE listings (
    id                  uuid PRIMARY KEY,
    legacy_id           integer UNIQUE,             -- id із SPA/test-data; NULL для нових
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    kind                listing_kind NOT NULL,
    mode                transport_mode NOT NULL,
    components          transport_mode[],
    origin_city_id      text NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    destination_city_id text NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    origin_country      char(2) NOT NULL,
    destination_country char(2) NOT NULL,
    is_cross_border     boolean GENERATED ALWAYS AS (origin_country <> destination_country) STORED,
    ready_date          date NOT NULL,
    cargo_type_id       text NOT NULL REFERENCES cargo_types(id) ON DELETE RESTRICT,
    weight_kg           numeric(14,3) NOT NULL CHECK (weight_kg > 0),
    volume_m3           numeric(12,3) CHECK (volume_m3 IS NULL OR volume_m3 > 0),
    price_amount        numeric(14,2) NOT NULL CHECK (price_amount >= 0),
    price_currency      text NOT NULL REFERENCES currencies(code) ON DELETE RESTRICT,
    price_kind          price_kind NOT NULL DEFAULT 'fixed',
    status              listing_status NOT NULL DEFAULT 'active',
    source              listing_source NOT NULL DEFAULT 'manual',
    expires_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT listings_origin_ne_destination CHECK (origin_city_id <> destination_city_id),
    -- Мультимодальна заявка мусить мати щонайменше два плеча, і лише базові види.
    CONSTRAINT listings_components_rule CHECK (
        (mode = 'multi'  AND components IS NOT NULL AND array_length(components, 1) >= 2
                         AND NOT (components && ARRAY['multi','drone']::transport_mode[]))
        OR (mode <> 'multi' AND components IS NULL)
    )
);
CREATE INDEX listings_feed_idx    ON listings (status, kind, mode, created_at DESC);
CREATE INDEX listings_route_idx   ON listings (origin_city_id, destination_city_id) WHERE status = 'active';
CREATE INDEX listings_country_idx ON listings (origin_country, destination_country) WHERE status = 'active';
CREATE INDEX listings_date_idx    ON listings (ready_date) WHERE status = 'active';
CREATE INDEX listings_currency_idx ON listings (price_currency) WHERE status = 'active';
CREATE INDEX listings_company_idx ON listings (company_id, created_at DESC);
CREATE INDEX listings_components_idx ON listings USING gin (components);

-- Дрон-специфіка винесена окремо: цих полів немає в жодного іншого виду транспорту.
CREATE TABLE listing_drone_details (
    listing_id     uuid PRIMARY KEY REFERENCES listings(id) ON DELETE CASCADE,
    range_km       numeric(8,2) NOT NULL CHECK (range_km > 0),
    max_payload_kg numeric(8,2) NOT NULL CHECK (max_payload_kg > 0),
    drone_type     text NOT NULL,
    flight_permit  boolean NOT NULL
);

-- Заявка з mode='drone' зобов'язана мати рядок деталей, і навпаки.
CREATE OR REPLACE FUNCTION assert_drone_details() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE has_details boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM listing_drone_details d WHERE d.listing_id = NEW.id)
      INTO has_details;
    IF NEW.mode = 'drone' AND NOT has_details THEN
        RAISE EXCEPTION 'listing %: mode=drone без listing_drone_details', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.mode <> 'drone' AND has_details THEN
        RAISE EXCEPTION 'listing %: listing_drone_details при mode=%', NEW.id, NEW.mode
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER listings_drone_details_trg
    AFTER INSERT OR UPDATE OF mode ON listings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_drone_details();

-- ---------------------------------------------------------------- журнал подій
-- Append-only. Основа майбутнього матчингу й прогнозу ставок (напрями поза Спринтом 0).
CREATE TABLE event_log (
    -- Первинний ключ партиціонованої таблиці зобов'язаний містити ключ секціонування,
    -- тому це (recorded_at, id), а не просто id.
    id           bigint GENERATED ALWAYS AS IDENTITY,
    kind         text NOT NULL,
    actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
    listing_id   uuid REFERENCES listings(id) ON DELETE SET NULL,
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip           inet,
    occurred_at  timestamptz NOT NULL,
    recorded_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (recorded_at, id)
) PARTITION BY RANGE (recorded_at);

CREATE TABLE event_log_2026q3 PARTITION OF event_log
    FOR VALUES FROM ('2026-07-01') TO ('2026-10-01');
CREATE TABLE event_log_2026q4 PARTITION OF event_log
    FOR VALUES FROM ('2026-10-01') TO ('2027-01-01');

CREATE INDEX event_log_kind_idx    ON event_log (kind, recorded_at DESC);
CREATE INDEX event_log_listing_idx ON event_log (listing_id, recorded_at DESC);

REVOKE UPDATE, DELETE ON event_log FROM PUBLIC;

-- ---------------------------------------------------------------- ідемпотентність
CREATE TABLE idempotency_keys (
    key           text NOT NULL,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint      text NOT NULL,
    request_hash  bytea NOT NULL,
    response_code integer,
    response_body jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    PRIMARY KEY (key, user_id, endpoint)
);

-- ---------------------------------------------------------------- контакти
CREATE TABLE contact_requests (
    id              uuid PRIMARY KEY,
    listing_id      uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contact_requests_unique_idx
    ON contact_requests (listing_id, requester_user_id);

COMMIT;
