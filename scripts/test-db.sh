#!/usr/bin/env bash
# Runs the pgTAP suite in supabase/tests/database.
#
# With a running local stack (`supabase start`), prefer `npm run db:test`,
# which calls `supabase test db`. This script is the fallback for machines
# without Docker: it boots a throwaway Postgres cluster, loads a small
# Supabase shim (roles, auth, storage), applies every migration in order and
# runs the tests with pg_prove.
#
# Requires: Postgres 15+ server binaries, pgTAP, pg_cron, pg_prove.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(pg_config --bindir 2>/dev/null || true)}"
if [[ -z "$PG_BIN" || ! -x "$PG_BIN/initdb" ]]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi
PORT="${PGTEST_PORT:-54399}"
WORK="$(mktemp -d)"
RUN_AS=()
if [[ "$(id -u)" == "0" ]]; then
  chown -R postgres "$WORK"
  RUN_AS=(runuser -u postgres --)
fi

cleanup() {
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
cat >>"$WORK/data/postgresql.conf" <<EOF
port = $PORT
listen_addresses = ''
unix_socket_directories = '$WORK'
shared_preload_libraries = 'pg_cron'
cron.database_name = 'postgres'
timezone = 'UTC'
wal_level = logical
client_min_messages = warning
EOF
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -w start >/dev/null

export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -f "$ROOT/scripts/supabase-shim.sql"
"${PSQL[@]}" -c "create extension pgtap with schema extensions"
for m in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate: $(basename "$m")"
  "${PSQL[@]}" -f "$m"
done

# pgTAP lives in `extensions`, as on Supabase.
PGOPTIONS="-c search_path=public,extensions" pg_prove --ext .sql "$@" "$ROOT"/supabase/tests/database
