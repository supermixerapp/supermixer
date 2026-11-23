#!/usr/bin/env bash
# Replaces the bundled stack template with supabase/docker at a commit.
#
#   backend/internal/provision/sync-template.sh <commit sha>
#
# Copies only what a stack needs (compose files, .env.example, volumes/) into
# template/ and records the commit in template/VERSION. Review the diff, run
# the tests, and create a stack before committing a new template.
set -euo pipefail
sha="${1:?usage: sync-template.sh <supabase/supabase commit sha>}"
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Give the full 40-character commit sha." >&2
  exit 2
fi
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" remote add origin https://github.com/supabase/supabase
git -C "$work" sparse-checkout set docker
git -C "$work" fetch -q --depth 1 --filter=blob:none origin "$sha"
git -C "$work" checkout -q FETCH_HEAD

src="$work/docker"
dst="$here/template"
rm -rf "$dst"
mkdir -p "$dst"
cp "$src/docker-compose.yml" "$src/docker-compose.logs.yml" "$src/.env.example" "$dst/"
# volumes/proxy belongs to the Caddy and nginx overlays, which stacks don't use.
(cd "$src" && find volumes -type f ! -path 'volumes/proxy/*' -print0 | xargs -0 -I{} sh -c 'mkdir -p "$1/$(dirname "{}")" && cp -p "{}" "$1/{}"' _ "$dst")
echo "$sha" > "$dst/VERSION"
echo "template/ is now supabase/docker at $sha ($(find "$dst" -type f | wc -l | tr -d ' ') files)"
