#!/usr/bin/env bash
# Stop the dev Supabase stack. Data is kept in Docker volumes and ./.stack.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.stack"
docker compose -p supermixer-dev-stack down
