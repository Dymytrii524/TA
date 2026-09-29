#!/usr/bin/env bash
set -euo pipefail
# GitHub's disposable PostgreSQL service ONLY. Never a production connection.
: "${PG_SERVICE_CONTAINER:?required disposable CI container id}"
docker exec "$PG_SERVICE_CONTAINER" pg_dump -U web3_test -Fc ta_web3_test > /tmp/ta-web3-ci.dump
docker exec "$PG_SERVICE_CONTAINER" createdb -U web3_test ta_web3_restore
docker exec -i "$PG_SERVICE_CONTAINER" pg_restore -U web3_test --exit-on-error -d ta_web3_restore < /tmp/ta-web3-ci.dump
sql="SELECT md5(coalesce(string_agg(subledger::text,'|' ORDER BY id),'')) FROM web3.wallet_snapshots_v2;"
before=$(docker exec "$PG_SERVICE_CONTAINER" psql -U web3_test -d ta_web3_test -Atc "$sql")
after=$(docker exec "$PG_SERVICE_CONTAINER" psql -U web3_test -d ta_web3_restore -Atc "$sql")
test "$before" = "$after"
sql="SELECT md5(coalesce(string_agg(subledger::text,'|' ORDER BY id),'')) FROM web3.wallet_reconciliations;"
test "$(docker exec "$PG_SERVICE_CONTAINER" psql -U web3_test -d ta_web3_test -Atc "$sql")" = \
     "$(docker exec "$PG_SERVICE_CONTAINER" psql -U web3_test -d ta_web3_restore -Atc "$sql")"
echo "PASS PostgreSQL backup/restore: V1 and V2 immutable snapshot payloads identical"
