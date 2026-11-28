#!/bin/sh
# Certbot deploy hook: copies the renewed certificate to Supermixer, which
# loads it within 30 seconds and passes it to its stacks. Install:
#
#   sudo install -m 755 certbot-hook.sh /etc/letsencrypt/renewal-hooks/deploy/supermixer
#   sudo /etc/letsencrypt/renewal-hooks/deploy/supermixer    # now, for the current certificate
#
# It reads SUPERMIXER_DOMAIN (and SUPERMIXER_DATA) from Supermixer's .env.
set -eu

dir=${SUPERMIXER_DIR:-/opt/supermixer}   # where compose.yml and .env are
setting() { sed -n "s/^$1=//p" "$dir/.env" | tail -n 1 | tr -d "\"'"; }
domain=$(setting SUPERMIXER_DOMAIN)
data=$(setting SUPERMIXER_DATA)
data=${data:-/var/lib/supermixer}
if [ -z "$domain" ]; then
	echo "supermixer: no SUPERMIXER_DOMAIN in $dir/.env" >&2
	exit 1
fi
live=/etc/letsencrypt/live/$domain

# Certbot runs every deploy hook after each renewal: only this certificate's
# matters.
if [ -n "${RENEWED_LINEAGE:-}" ] && [ "$RENEWED_LINEAGE" != "$live" ]; then
	exit 0
fi

dest=$data/tls
install -d -m 700 -o 65532 -g 65532 "$dest"
# Both under temporary names first, then renamed, so Supermixer never reads
# half a file.
for f in fullchain privkey; do
	install -m 600 -o 65532 -g 65532 "$live/$f.pem" "$dest/.$f.pem.tmp"
done
mv -f "$dest/.privkey.pem.tmp" "$dest/privkey.pem"
mv -f "$dest/.fullchain.pem.tmp" "$dest/fullchain.pem"
echo "supermixer: copied the certificate for $domain to $dest"
