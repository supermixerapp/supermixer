#!/usr/bin/env bash
# Prepares an end-to-end run (make e2e): a fresh supermixer_e2e database on
# the development Postgres (make db) and a settings file for it in
# web/e2e/.tmp/, which Playwright's servers use. Nothing else is touched.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p web/e2e/.tmp
docker compose -f deploy/docker-compose.yml exec -T db psql -q -U supermixer -d supermixer \
  -c 'DROP DATABASE IF EXISTS supermixer_e2e WITH (FORCE)' \
  -c 'CREATE DATABASE supermixer_e2e'

key="$(openssl rand -base64 32)"
umask 077
cat > web/e2e/.tmp/e2e.toml <<TOML
[server]
listen = "127.0.0.1:8091"
public_url = "http://127.0.0.1:5176"

[database]
url = "postgres://supermixer:supermixer@localhost:5433/supermixer_e2e?sslmode=disable"

[security]
encryption_key = "$key"

[bootstrap_admin]
username = "admin"
# Throwaway, for this test database only; the test replaces it on first sign-in.
password = "e2e-first-admin-password"
TOML
echo "e2e: fresh database supermixer_e2e, settings in web/e2e/.tmp/e2e.toml"
