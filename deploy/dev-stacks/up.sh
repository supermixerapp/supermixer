#!/usr/bin/env bash
# Start a self-hosted Supabase stack for developing and testing Supermixer.
#
# Uses Supabase's official docker/ setup at a pinned commit, with fresh secrets
# and ports moved out of the way (API 8100, Postgres pooler 54322/64322).
# Prints the details to paste into Supermixer's "New project" form.
#
#   deploy/dev-stacks/up.sh            start (first run downloads ~3 GB of images)
#   deploy/dev-stacks/down.sh          stop, keeping data
#
# Override with env vars: SUPABASE_REF, STACK_API_PORT, STACK_DB_PORT.
set -euo pipefail

SUPABASE_REF="${SUPABASE_REF:-8728c41ad3878df66b3f5eec2232ffcebfb25d13}"
API_PORT="${STACK_API_PORT:-8100}"
DB_PORT="${STACK_DB_PORT:-54322}"
TX_PORT=$((DB_PORT + 10000))
TENANT="supermixer-dev"
PROJECT="supermixer-dev-stack"

here="$(cd "$(dirname "$0")" && pwd)"
stack="$here/.stack"

if [ ! -f "$stack/docker-compose.yml" ]; then
  echo "Fetching supabase/docker at $SUPABASE_REF..."
  src="$here/.src"
  mkdir -p "$src"
  git -C "$src" init -q
  git -C "$src" remote add origin https://github.com/supabase/supabase 2>/dev/null || true
  git -C "$src" sparse-checkout set docker
  git -C "$src" fetch -q --depth 1 --filter=blob:none origin "$SUPABASE_REF"
  git -C "$src" checkout -q FETCH_HEAD
  mkdir -p "$stack"
  cp -R "$src/docker/." "$stack/"
fi

cd "$stack"
if [ ! -f .env ]; then
  echo "Generating secrets..."
  cp .env.example .env
  sh utils/generate-keys.sh --update-env >/dev/null
  set_env() { # key value
    if grep -q "^$1=" .env; then
      sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
    else
      echo "$1=$2" >> .env
    fi
  }
  set_env API_GW_HTTP_PORT "$API_PORT"
  set_env KONG_HTTP_PORT "$API_PORT"
  set_env POSTGRES_PORT "$DB_PORT"
  set_env POOLER_PROXY_PORT_TRANSACTION "$TX_PORT"
  set_env POOLER_TENANT_ID "$TENANT"
  set_env SUPABASE_PUBLIC_URL "http://localhost:$API_PORT"
  set_env API_EXTERNAL_URL "http://localhost:$API_PORT/auth/v1"
fi

docker compose -p "$PROJECT" up -d --wait

get() { grep "^$1=" .env | head -1 | cut -d= -f2-; }
cat <<EOF

Supabase dev stack is running. Register it in Supermixer with:

  API URL            http://localhost:$API_PORT
  Studio URL         http://localhost:$API_PORT  (user: $(get DASHBOARD_USERNAME))
  Anon key           $(get ANON_KEY)
  Service role key   $(get SERVICE_ROLE_KEY)
  JWT secret         $(get JWT_SECRET)
  Database host      localhost
  Database port      $DB_PORT
  Database name      $(get POSTGRES_DB)
  Database user      postgres.$TENANT
  Database password  $(get POSTGRES_PASSWORD)
  SSL mode           disable

All values are in $stack/.env
EOF
