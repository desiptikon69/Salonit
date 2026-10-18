#!/bin/sh
set -eu

cd /app

if [ -n "${DATABASE_URL:-}" ]; then
  node tools/wait-for-db.mjs

  if [ "${RUN_MIGRATIONS:-1}" = "1" ]; then
    echo "Applying database migrations..."
    node tools/migrate.mjs
  fi

  if [ "${SEED_DEMO:-0}" = "1" ]; then
    if [ -z "${DEMO_PASSWORD:-}" ]; then
      echo "DEMO_PASSWORD is required when SEED_DEMO=1" >&2
      exit 1
    fi
    echo "Preparing demo data (idempotent)..."
    node tools/seed.mjs
  fi

  if [ "${RUN_INSTALLATION_INIT:-0}" = "1" ]; then
    echo "Initializing a clean installation..."
    node tools/init.mjs
  fi
fi

exec node server.js
