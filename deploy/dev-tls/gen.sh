#!/bin/sh
# Makes a private CA and a certificate from it, for trying TLS in
# development ([tls] mode = "files"):
#
#   deploy/dev-tls/gen.sh [extra host names or IP addresses...]
#
# The certificate covers localhost, 127.0.0.1, ::1 and host.docker.internal,
# plus any names given. Then, in .env.toml:
#
#   [server]
#   public_url = "https://localhost:8443"
#   https_listen = ":8443"
#   [tls]
#   mode = "files"
#   cert_file = "<repo>/deploy/dev-tls/out/fullchain.pem"
#   key_file = "<repo>/deploy/dev-tls/out/key.pem"
#   ca_file = "<repo>/deploy/dev-tls/out/ca.pem"
#
# Browsers and psql trust the certificate once ca.pem is trusted (on macOS:
# open out/ca.pem and mark it trusted in Keychain Access), or pass it
# explicitly: curl --cacert out/ca.pem, psql "... sslrootcert=out/ca.pem".
# Running it again keeps the CA and makes a new certificate, as a renewal
# would.
set -eu
out="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$out"
cd "$out"

if [ ! -f ca.pem ]; then
	openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
		-keyout ca.key -out ca.pem -days 3650 -subj "/O=Supermixer development/CN=Supermixer dev CA" \
		-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
	chmod 600 ca.key
	echo "made a CA: $out/ca.pem"
fi

san="DNS:localhost,IP:127.0.0.1,IP:::1,DNS:host.docker.internal"
for name in "$@"; do
	case "$name" in
	*[!0-9.:a-fA-F]* ) san="$san,DNS:$name" ;;
	* ) san="$san,IP:$name" ;;
	esac
done

openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
	-keyout key.pem.new -out cert.csr -subj "/CN=localhost" 2>/dev/null
printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$san" >cert.ext
openssl x509 -req -in cert.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 397 \
	-extfile cert.ext -out cert.pem.new 2>/dev/null
cat cert.pem.new >fullchain.pem.new
rm -f cert.csr cert.ext cert.pem.new ca.srl
# Swap both at once, so Supermixer never reads a new certificate with the
# old key.
chmod 600 key.pem.new
mv key.pem.new key.pem
mv fullchain.pem.new fullchain.pem
echo "made a certificate for $san: $out/fullchain.pem and $out/key.pem"
cat <<SETTINGS

For .env.toml:

[server]
public_url = "https://localhost:8443"
https_listen = ":8443"

[tls]
mode = "files"
cert_file = "$out/fullchain.pem"
key_file = "$out/key.pem"
ca_file = "$out/ca.pem"
SETTINGS
