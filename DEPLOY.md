# Deploying Supermixer

Supermixer runs as one binary, with the web app built in, under systemd, with nginx in front for HTTPS. It needs a Postgres database for its own data (tested with Postgres 17).

## 1. Build a release (on your machine)

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

## 2. Install (on the server)

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

## 3. Database (if Postgres runs on this server)

```sh
sudo -u postgres createuser --pwprompt supermixer
sudo -u postgres createdb --owner supermixer supermixer
```

Supermixer creates its tables itself when it starts.

## 4. Configure

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

## 5. Start it with systemd

```sh
sudo cp supermixer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now supermixer
sudo systemctl status supermixer
journalctl -u supermixer -f
```

The first start prints the admin's one-time password in that log. Sign in as `admin` and choose a new one.

To let Supermixer create new Supabase stacks, install Docker and uncomment `SupplementaryGroups=docker` in the unit. Docker access is root-equivalent on the host.

## 6. nginx and HTTPS

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

## Upgrading

```sh
sudo install -m 755 supermixer /usr/local/bin/supermixer
sudo systemctl restart supermixer
```

Back up Supermixer's database first. Changes to its tables are applied when it starts.
