#!/bin/sh
# Stands in for the docker CLI in tests. Records each call in $FAKE_DOCKER_LOG;
# fails `compose <cmd>` when $FAKE_DOCKER_FAIL is <cmd> (or, once, when the
# file $FAKE_DOCKER_FAIL_ONCE holds it), and `network create` when
# $FAKE_DOCKER_NETWORKS_FULL is set.
echo "$*" >> "${FAKE_DOCKER_LOG:-/dev/null}"
if [ "$1" = "ps" ]; then
  # Something outside Supermixer already publishes 8200.
  echo "0.0.0.0:8200->8000/tcp"
  exit 0
fi
# $FAKE_DOCKER_NETWORKS_FULL: Docker's address pools are used up.
if [ "$1" = "network" ]; then
  if [ "$2" = "create" ] && [ -n "${FAKE_DOCKER_NETWORKS_FULL:-}" ]; then
    echo "Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network" >&2
    exit 1
  fi
  exit 0
fi
if [ "$1" = "compose" ]; then
  # Find the subcommand after the global flags.
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --project-name|--project-directory|--file|--profile) shift 2 ;;
      *) break ;;
    esac
  done
  cmd="$1"
  # $FAKE_DOCKER_FAIL_ONCE names a file holding a subcommand to fail once.
  if [ -n "${FAKE_DOCKER_FAIL_ONCE:-}" ] && [ -f "$FAKE_DOCKER_FAIL_ONCE" ] && [ "$cmd" = "$(cat "$FAKE_DOCKER_FAIL_ONCE")" ]; then
    rm -f "$FAKE_DOCKER_FAIL_ONCE"
    echo "Error response from daemon: pretend $cmd failed once" >&2
    exit 1
  fi
  if [ "$cmd" = "${FAKE_DOCKER_FAIL:-}" ]; then
    echo "Error response from daemon: pretend $cmd failed" >&2
    exit 1
  fi
  case "$cmd" in
    version) echo "${FAKE_COMPOSE_VERSION-2.29.1}" ;;
    ps)
      echo '{"Service":"db","Name":"x-db-1","State":"running","Health":"healthy","Status":"Up 1 minute (healthy)"}'
      [ -n "${FAKE_STUDIO_STATE-}" ] && echo '{"Service":"studio","Name":"x-studio-1","State":"'"$FAKE_STUDIO_STATE"'","Health":"","Status":"x"}'
      ;;
    exec)
      # Stand in for the db container: its version, a dump, or a restore reading SQL.
      case "$*" in
        *server_version*) echo "${FAKE_PG_VERSION-17.6}" ;;
        *" bash -s"*) cat > /dev/null; echo "-- a dump by fake-docker.sh"; echo "SELECT 1;" ;;
        *" psql "*"-f -"*) cat > "${FAKE_DOCKER_STDIN:-/dev/null}" ;;
        *) cat > /dev/null ;;
      esac ;;
    *) echo "Container x $cmd ok" ;;
  esac
  exit 0
fi
exit 0
