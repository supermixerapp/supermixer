#!/usr/bin/env bash
# Check that the dev stack's Logs show its own containers' logs and nobody
# else's. Vector reads logs from the whole Docker host, so a container from
# another Compose project (another stack, Supermixer's own database, any app)
# must not end up in this stack's log tables.
#
# A throwaway container labelled as another project's "rest" and "db"
# services prints a marker; the stack's Postgres logs a second one. The
# check waits for the stack's marker (so logs are flowing), then fails if the
# foreign one reached any of Logflare's tables.
set -euo pipefail
PROJECT="supermixer-dev-stack"
db="$PROJECT-db-1"

if ! docker inspect -f '{{.State.Running}}' "$db" 2>/dev/null | grep -q true; then
  echo "The dev stack isn't running; start it with make stack." >&2
  exit 1
fi
if ! docker inspect "$PROJECT-vector-1" >/dev/null 2>&1; then
  echo "The dev stack runs without log analytics (STACK_LOGS=0); nothing to check." >&2
  exit 1
fi

id="$(date +%s)$RANDOM"
foreign="supermixer_foreign_probe_$id"
own="supermixer_own_probe_$id"
psql_supabase() { docker exec "$db" psql -U postgres -d _supabase -AtX -v ON_ERROR_STOP=1 "$@"; }

# Counts marker lines in every log table Logflare has.
count() { # marker
  psql_supabase -c "
    do \$\$ declare t text; n bigint := 0; c bigint; begin
      for t in select format('_analytics.%I', tablename) from pg_tables
               where schemaname = '_analytics' and tablename like 'log\_events\_%' loop
        execute format('select count(*) from %s where event_message like %L', t, '%$1%') into c;
        n := n + c;
      end loop;
      raise notice 'count=%', n;
    end \$\$;" 2>&1 | sed -n 's/.*count=\([0-9]*\).*/\1/p'
}

# The stack's own image, so nothing is downloaded. Two services, both of
# which this stack also has, labelled as another project.
image="$(docker inspect -f '{{.Config.Image}}' "$db")"
for svc in rest db; do
  docker run -d --rm --name "supermixer-leak-probe-$svc-$id" \
    --label com.docker.compose.project=supermixer-leak-probe \
    --label com.docker.compose.service="$svc" \
    --entrypoint sh "$image" -c "for i in 1 2 3 4 5; do echo \"$foreign $svc\"; sleep 1; done" >/dev/null
done

# The stack's Postgres logs only FATAL messages; connecting to a database
# that doesn't exist is one, and names the marker.
docker exec "$db" psql -U postgres -d "$own" -AtX -c "select 1" >/dev/null 2>&1 || true

echo "Waiting for the stack's own log line to arrive..."
for _ in $(seq 1 30); do
  [ "$(count "$own")" -gt 0 ] && break
  sleep 2
done
if [ "$(count "$own")" -eq 0 ]; then
  echo "FAIL: the stack's own Postgres log line never arrived; is Vector routing logs?" >&2
  exit 1
fi
# Give the probe's lines as long again to show up, had they been collected.
sleep 10
leaked="$(count "$foreign")"
if [ "$leaked" -gt 0 ]; then
  echo "FAIL: $leaked log lines from another Compose project reached this stack's logs." >&2
  echo "Rerun up.sh so scope-vector.py limits Vector to project $PROJECT." >&2
  exit 1
fi
echo "OK: the stack's own logs arrive, and other projects' containers don't."
