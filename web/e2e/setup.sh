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

[webhooks]
# The test's webhook receiver listens on 127.0.0.1.
allow_private_addresses = true

[bootstrap_admin]
username = "admin"
# Throwaway, for this test database only; the test replaces it on first sign-in.
password = "e2e-first-admin-password"
TOML
# Single sign-on through Dex (make sso), when it's running.
if curl -sf -o /dev/null --max-time 3 http://localhost:5556/dex/.well-known/openid-configuration; then
  cat >> web/e2e/.tmp/e2e.toml <<'TOML'

[[sso.providers]]
id = "dex"
name = "Dex"
issuer = "http://localhost:5556/dex"
client_id = "supermixer"
client_secret = "dev-only-secret"
# Dex's test users (deploy/dev-sso/dex.yaml); without domains, new accounts would wait for approval.
allowed_domains = ["example.test"]
create_users = true
TOML
  echo "e2e: Dex is running, so single sign-on is set up and tested"
fi
echo "e2e: fresh database supermixer_e2e, settings in web/e2e/.tmp/e2e.toml"
