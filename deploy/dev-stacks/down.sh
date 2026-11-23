#!/usr/bin/env bash
# Stop the dev Supabase stack. Data is kept in Docker volumes and ./.stack.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ ! -f "$here/.stack/docker-compose.yml" ]; then
  echo "No dev stack has been created; nothing to stop."
  exit 0
fi
cd "$here/.stack"
# Name every file up.sh may have used, so the log containers stop too.
docker compose -p supermixer-dev-stack -f docker-compose.yml -f "$here/storage-volume.yml" -f docker-compose.logs.yml down
