# Deploying Supermixer

Two ways:

- **[With Docker](#with-docker)** (recommended): Supermixer and its own Postgres run in containers, and Supermixer
  creates Supabase stacks on the same Docker. You install Docker, nginx and certbot; Supermixer sets up the rest.
- **[Without Docker](#without-docker-binary-and-systemd)**: one binary under systemd, with a Postgres you provide.

Either way nginx on the host handles HTTPS for Supermixer's web app, with a Let's Encrypt certificate.

## With Docker

What's reachable from the internet: nginx (80, 443) and each stack's three ports, which only accept encrypted
connections. Supermixer listens on 127.0.0.1 for nginx; its database has no port at all.

### Before you start

- A Linux server (amd64 or arm64), used only for Supermixer and its stacks: Supermixer controls Docker, which is
  root-equivalent.
- Docker Engine with the Compose plugin, 2.24.4 or later, installed from Docker's own repository:
  <https://docs.docker.com/engine/install/>. Not the Ubuntu snap (`snap list docker` should find nothing): the snap
  can't use folders outside your home folder, such as `/var/lib/supermixer`.
- A DNS name for the server, such as `supermixer.example.com`. Supermixer's web app and the stacks all use it. Point
  it at the server now, because the certificate in step 4 needs it:
  ```sh
  dig +short supermixer.example.com      # must print this server's public address
  ```
  If you add an IPv6 (AAAA) record, it must point at this server too.
- For more than about 25 stacks, give Docker more network room first: see "Room for more than about 30 stacks" in
  the README.

### 1. Get the files

They come in the image:

```sh
sudo mkdir -p /opt/supermixer && cd /opt/supermixer
id=$(sudo docker create supermixer/supermixer:0.1.0)
sudo docker cp "$id":/usr/share/supermixer/. .
sudo docker rm "$id"
```

### 2. Set the version and host name

```sh
sudo cp env.example .env
sudoedit .env        # SUPERMIXER_VERSION and SUPERMIXER_DOMAIN
```

### 3. Start it

```sh
sudo docker compose up -d
sudo docker compose logs supermixer | grep 'one-time password'
```

The first start creates `/var/lib/supermixer` (secrets, certificate, stacks, backups), generates the encryption key
and the database password, sets up the database and prints the admin's one-time password. Keep it for step 6.
After that, Docker starts everything again by itself when the server boots.

### 4. Get a certificate and hand it to Supermixer

```sh
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot certonly --nginx -d supermixer.example.com --deploy-hook "systemctl reload nginx"

# Copies the certificate to Supermixer now and after every renewal
sudo install -m 755 certbot-hook.sh /etc/letsencrypt/renewal-hooks/deploy/supermixer
sudo /etc/letsencrypt/renewal-hooks/deploy/supermixer
```

The hook looks for `.env` in `/opt/supermixer`. If you put the files somewhere else, change the `dir=` line in
`/etc/letsencrypt/renewal-hooks/deploy/supermixer` to match.

### 5. Set up nginx

```sh
sudo cp supermixer.conf /etc/nginx/conf.d/supermixer.conf
sudoedit /etc/nginx/conf.d/supermixer.conf     # replace supermixer.example.com
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Sign in

Open `https://supermixer.example.com`, sign in as `admin` with the one-time password and choose a new one.

### 7. Firewall

```sh
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Docker opens the stacks' ports itself (8200–8299, 54400–54499 and 64400–64499 by default). If your cloud provider
has its own firewall, allow those there too.

### 8. Daily backup of Supermixer's database

Supermixer saves its own database before each upgrade. For a daily copy too:

```sh
sudo tee /etc/cron.daily/supermixer-db >/dev/null <<'EOF'
#!/bin/sh
# Saves Supermixer's database every day, keeping one per weekday (7 in all).
set -eu
dir=/var/lib/supermixer/backups/supermixer
out=$dir/daily-$(date +%u).dump
umask 077
mkdir -p "$dir"
cd /opt/supermixer
docker compose exec -T db pg_dump -U supermixer -Fc supermixer > "$out.partial"
mv -f "$out.partial" "$out"
EOF
sudo chmod 755 /etc/cron.daily/supermixer-db
sudo /etc/cron.daily/supermixer-db           # once now, to check it works
sudo ls -l /var/lib/supermixer/backups/supermixer
```

### 9. Back up the secrets

Copy `/var/lib/supermixer/secrets` somewhere safe, off the server. Without the encryption key, stored Supabase
credentials can't be read.

### Check it works

Once, on a new server:

1. `sudo docker compose ps`: `db` and `supermixer` are `healthy`.
2. `curl -sI http://supermixer.example.com` answers with a redirect to `https://`.
3. In the web app, create a project with a new stack. Then, with its details from the Connect sheet:
   - `curl -sS -o /dev/null -w '%{http_code}\n' https://supermixer.example.com:<api port>/` prints a status code
     (any), not a certificate error;
   - `psql "postgresql://postgres.<ref>@supermixer.example.com:<db port>/postgres?sslmode=verify-full&sslrootcert=system"`
     connects (psql 16 or later);
   - the same with `sslmode=disable` is refused.
4. From another computer, `nmap -Pn -p 1-65535 supermixer.example.com` shows only 22, 80, 443 and the stack's
   three ports.
5. `sudo certbot renew --force-renewal`, then within 2 minutes the stack's ports show the new expiry date:
   ```sh
   openssl s_client -connect supermixer.example.com:<api port> </dev/null 2>/dev/null | openssl x509 -noout -enddate
   ```
   Let's Encrypt allows only a few renewals of the same certificate a week, so do this once.
6. `sudo reboot`. Afterwards `sudo docker compose ps` shows Supermixer healthy again, and the stack is running.

### Settings

`.env` has the version and the host name. Everything else (email, single sign-on, S3 backups, port ranges) goes in
`config.toml`; `.env.example.toml` in the repository lists every setting. Apply changes with
`sudo docker compose up -d` (for `.env`) or `sudo docker compose restart supermixer` (for `config.toml`).

Settings that go together:

- `SUPERMIXER_PORT` in `.env` (the port nginx reaches Supermixer on, 8080 by default) must match
  `server 127.0.0.1:8080;` in `/etc/nginx/conf.d/supermixer.conf`.
- `SUPERMIXER_DATA` in `.env` (the data folder, `/var/lib/supermixer` by default): if you change it, change the
  paths in the daily backup script and in these steps too. The certbot hook reads it from `.env`.

### Upgrading

```sh
cd /opt/supermixer
sudoedit .env                                   # the new SUPERMIXER_VERSION
sudo docker compose pull && sudo docker compose up -d
```

Supermixer saves its database to `/var/lib/supermixer/backups/supermixer` (as `supermixer-schema-*.dump`, keeping 5)
before applying changes to it. If the release notes say `compose.yml` changed, copy the new one out of the image as
in step 1.

### Backing up

- `/var/lib/supermixer/secrets`: once (step 9).
- Supermixer's database: daily (step 8), and before each upgrade.
- The stacks: backed up daily to `/var/lib/supermixer/backups/stacks`. To keep copies off the server, turn on S3
  backups in `config.toml`.

### Restoring

**Supermixer's database**, from a daily or pre-upgrade dump:

```sh
cd /opt/supermixer
sudo docker compose stop supermixer
sudo docker compose exec -T db dropdb -U supermixer supermixer
sudo docker compose exec -T db createdb -U supermixer supermixer
sudo cat /var/lib/supermixer/backups/supermixer/daily-1.dump \
  | sudo docker compose exec -T db pg_restore -U supermixer -d supermixer
sudo docker compose start supermixer
```

Changes since that dump are lost.

**Going back after a bad upgrade:** set `SUPERMIXER_VERSION` in `.env` back to the old version. Restore the newest
`supermixer-schema-*.dump` as above, but finish with `sudo docker compose up -d` instead of `start supermixer`, so the
old version starts. Don't start the old version before restoring: it may not work with a database the new one has
changed.

**A stack:** in the web app, open the project, then Database › Backups, and choose a backup › Restore to this
project. Supermixer saves the current database first.

**The secrets**, on a rebuilt server: copy them back to `/var/lib/supermixer/secrets` before step 3. Supermixer never
replaces existing secrets.

### Publishing a version (maintainers)

`git tag v0.2.0 && git push origin v0.2.0`: GitHub Actions builds the image for amd64 and arm64 and pushes it to
Docker Hub as `supermixer/supermixer:0.2.0` (the repository needs the secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`). Or by hand: `docker login`, then `make image-push`.

## Without Docker: binary and systemd

Here you provide Postgres (tested with 17), and Supermixer runs as one binary with the web app built in.

### 1. Build a release (on your machine)

```sh
git tag v0.1.0              # optional: names the release
make release
```

This writes `bin/release/supermixer-<version>-linux-amd64.tar.gz` (and `-arm64`), each with:

- `supermixer`: the server;
- `mixer`: an optional link test;
- `config.example.toml`;
- `supermixer.service`;
- `supermixer.conf` (nginx);
- this file.

Copy the right one to the server:

```sh
scp bin/release/supermixer-*-linux-amd64.tar.gz you@server:
```

### 2. Install (on the server)

```sh
tar -xzf supermixer-*-linux-amd64.tar.gz
cd supermixer-*-linux-amd64

# The binary
sudo install -m 755 supermixer /usr/local/bin/supermixer

# A system user with no login
sudo useradd --system --home-dir /var/lib/supermixer --no-create-home \
  --shell /usr/sbin/nologin supermixer

# Config folder: readable by the service, not by other users
sudo install -d -m 750 -o root -g supermixer /etc/supermixer

# Data folder (stacks, backups, certificates); systemd also creates it
sudo install -d -m 700 -o supermixer -g supermixer /var/lib/supermixer
```

### 3. Database (if Postgres runs on this server)

```sh
sudo -u postgres createuser --pwprompt supermixer
sudo -u postgres createdb --owner supermixer supermixer
```

Supermixer creates its tables itself when it starts.

### 4. Configure

```sh
key=$(openssl rand -base64 32)
sed 's|^encryption_key = ""$|encryption_key = "'"$key"'"|' config.example.toml \
  | sudo tee /etc/supermixer/config.toml >/dev/null
sudo chown root:supermixer /etc/supermixer/config.toml
sudo chmod 640 /etc/supermixer/config.toml
sudoedit /etc/supermixer/config.toml
```

Set at least:

```toml
[server]
listen = "127.0.0.1:8080"                      # only nginx reaches it
public_url = "https://supermixer.example.com"
trust_proxy = true

[database]
url = "postgres://supermixer:PASSWORD@localhost:5432/supermixer"
```

Keep a copy of `encryption_key` somewhere safe. Without it, stored Supabase credentials can't be read.

### 5. Start it with systemd

```sh
sudo cp supermixer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now supermixer
sudo systemctl status supermixer
journalctl -u supermixer -f
```

The first start prints the admin's one-time password in that log. Sign in as `admin` and choose a new one.

To let Supermixer create new Supabase stacks, install Docker and uncomment `SupplementaryGroups=docker` in the unit.
Docker access is root-equivalent on the host.

### 6. nginx and HTTPS

Get a certificate first, because nginx won't load the config without one:

```sh
sudo certbot certonly --nginx -d supermixer.example.com \
  --deploy-hook "systemctl reload nginx"
```

Then add the config:

```sh
sudo cp supermixer.conf /etc/nginx/conf.d/supermixer.conf
sudoedit /etc/nginx/conf.d/supermixer.conf     # replace supermixer.example.com
sudo nginx -t && sudo systemctl reload nginx
```

### Upgrading

```sh
sudo install -m 755 supermixer /usr/local/bin/supermixer
sudo systemctl restart supermixer
```

Back up Supermixer's database first. Changes to its tables are applied when it starts.
