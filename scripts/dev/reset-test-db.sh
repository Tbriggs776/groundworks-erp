#!/usr/bin/env bash
# Recreate a throwaway Postgres database for the e2e suites:
#   1. drop + create the database
#   2. apply the Supabase auth stub (auth.users, auth.uid(), roles)
#   3. run every migration
#   4. insert one auth user (the signup trigger mirrors it into profiles)
#
# Usage:  TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/gw_test \
#           scripts/dev/reset-test-db.sh
# Never point this at a real Supabase project — it DROPS the database.
set -euo pipefail

URL="${TEST_DATABASE_URL:?set TEST_DATABASE_URL}"
DB_NAME="${URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
ADMIN_URL="${URL%/*}/postgres"

psql "$ADMIN_URL" -qX -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DB_NAME\""
psql "$URL" -qX -v ON_ERROR_STOP=1 -f "$(dirname "$0")/supabase-stub.sql"
DATABASE_URL_MIGRATE="$URL" npx tsx scripts/migrate.ts
psql "$URL" -qX -v ON_ERROR_STOP=1 \
  -c "INSERT INTO auth.users (email) VALUES ('e2e@example.com')"
echo "Test database ready: $DB_NAME"
