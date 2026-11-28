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
# E2E_TLS=1: everything over HTTPS, with a certificate from a throwaway CA
# (deploy/dev-tls/gen.sh). Supermixer serves HTTPS on :8491 and only
# redirects on :8091; Vite serves HTTPS too and passes the API on.
scheme=http https_listen="" tls=""
if [ "${E2E_TLS:-}" = 1 ]; then
  deploy/dev-tls/gen.sh >/dev/null
  out="$(pwd)/deploy/dev-tls/out"
  scheme=https
  https_listen='https_listen = "127.0.0.1:8491"'
  tls="[tls]
mode = \"files\"
cert_file = \"$out/fullchain.pem\"
key_file = \"$out/key.pem\"
ca_file = \"$out/ca.pem\""
  echo "e2e: TLS on, with a certificate from deploy/dev-tls/out/ca.pem"
fi
umask 077
cat > web/e2e/.tmp/e2e.toml <<TOML
[server]
listen = "127.0.0.1:8091"
public_url = "$scheme://127.0.0.1:5176"
$https_listen

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

$tls
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
