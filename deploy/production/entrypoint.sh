#!/bin/sh
# Starts Supermixer in its container. Started as root (deploy/production
# does, so it needn't know the Docker socket's group), it drops to the
# supermixer user, 65532, adding the socket's group so it can create stacks.
# Started as anyone else, it runs as them. `init` always runs as started.
set -eu

if [ "$(id -u)" = 0 ] && [ "${1:-}" != init ]; then
	groups=65532
	if [ -S /var/run/docker.sock ]; then
		groups="$groups,$(stat -c %g /var/run/docker.sock)"
	fi
	exec setpriv --reuid=65532 --regid=65532 --groups="$groups" --inh-caps=-all --no-new-privs \
		/usr/local/bin/supermixer "$@"
fi
exec /usr/local/bin/supermixer "$@"
