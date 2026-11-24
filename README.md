# Supermixer

An on-premise management plane for self-hosted Supabase: organizations, projects, users and access control, in a console that looks and works like supabase.com/dashboard.

**Status: Stage 1** (identity, organizations, projects, access control). You can sign in, create organizations, invite a team with Supabase's roles, and register running self-hosted Supabase stacks as projects with live health checks. Pages for later stages show which stage brings them.

## Requirements

- Go 1.24 or newer. The module needs Go 1.26, which Go downloads automatically.
- Node 24 and pnpm 10
- Docker, for Supermixer's own Postgres (`make dev`, `make test-integration`), `make generate`, and the dev Supabase stack (`make stack`, about 3 GB of images)

## Getting started

```sh
make setup   # install dependencies; creates .env.toml with a fresh encryption key
make dev     # starts Postgres (port 5433), the API (:8080, live reload) and Vite (:5173)
```

Open http://localhost:5173 and sign in as `admin`, with the one-time password Supermixer prints in its log on first start (or `bootstrap_admin.password` from `.env.toml`, if you set one). You choose a new password before anything else.

To try project registration against a real stack:

```sh
make stack   # starts a self-hosted Supabase on :8100 (first run downloads ~3 GB) and prints its details
```

Then use **New project** in Supermixer. **Fill from Supabase .env** fills the form from the stack's pasted `.env` (Supabase's own file, not Supermixer's `.env.toml`); for this stack that's `deploy/dev-stacks/.stack/.env`.

## Common tasks

| Command | What it does |
|---|---|
| `make build` | Single binary with the web UI embedded, written to `bin/supermixer` |
| `make test` | Go and web tests; integration tests are skipped if Postgres isn't running |
| `make test-integration` | Starts Postgres, then runs every Go test |
| `make e2e` | End-to-end walk-through in your installed Chrome (Playwright): first sign-in, an organization, registering the dev stack (`make stack` first), a Read-only member who can't see keys or change settings, and the audit log. Uses its own Supermixer (:8091), web app (:5176) and `supermixer_e2e` database, so `make dev` is untouched; a failure leaves a trace in `web/test-results/` |
| `make stack` / `make stack-down` | Start or stop a dev self-hosted Supabase stack; it can run next to other Supabase stacks |
| `make lint` | go vet, ESLint and the TypeScript type check |
| `make generate` | Regenerates code after editing `api/openapi.yaml` or SQL queries |
| `make app` | Runs Supermixer and its database in containers, reading `.env.toml` |
| `make app-stacks` | Like `make app`, but the container may create Supabase stacks (see below) |
| `make stack-check-logs` | Checks the dev stack's Logs pages get its own logs and no other container's |

## Configuration

Settings live in `.env.toml`, a TOML file with sections for the server, logging, the database, security, appearance and how Supermixer talks to projects. Every setting is documented in [.env.example.toml](.env.example.toml); unknown keys stop the server with an error, so typos don't go unnoticed.

```toml
[appearance]
brand_color = "#0019A8"   # re-themes the whole UI on restart, no rebuild

[security.sign_in]
max_failures = 10
lockout = "15m"
```

- `supermixer --config path/to/file.toml` picks another file; so does `SUPERMIXER_CONFIG`.
- Any setting can be overridden by an environment variable named after its key: `SUPERMIXER_<SECTION>_<KEY>`, for example `SUPERMIXER_DATABASE_URL` or `SUPERMIXER_SECURITY_SIGN_IN_LOCKOUT`. Containers can inject secrets this way without a file.

## Email

With an SMTP server in `[email]`, Supermixer emails invitation links, "Forgot your password?" links (accounts with two-factor sign-in need a code as well) and notices when an account's password or two-factor sign-in changes. Without one, invitations give a link to share and only instance admins reset passwords. **Instance › Overview › Send test email** checks the settings.

```toml
[email]
smtp_host = "smtp.example.com"
smtp_port = 587
security = "starttls"           # or tls (port 465), or none
username = "supermixer"         # password: SUPERMIXER_EMAIL_PASSWORD
from = "Supermixer <supermixer@example.com>"
```

For development, `make mail` runs [Mailpit](https://mailpit.axllent.org), which keeps everything it's sent: set `smtp_host = "localhost"`, `smtp_port = 1025`, `security = "none"` and read the mail at http://localhost:8025.

## Passwords

New passwords follow NIST SP 800-63B-4: at least 15 characters for an account that signs in with a password alone, or 8 with two-factor sign-in on; not one of the UK NCSC's 100,000 most used passwords (bundled, so this works offline) or the username. Characters are counted after Unicode normalization (NFKC). An account without two-factor sign-in whose password is shorter than 15 characters is asked to choose a new one at its next sign-in.

## Single sign-on

Supermixer can sign people in through OpenID Connect providers (Okta, Microsoft Entra ID, Google Workspace, Keycloak, Authentik, Dex, ...), with a **Continue with ...** button for each on the sign-in page. Register `<public_url>/api/v1/auth/sso/<id>/callback` as the redirect URI with the provider, then:

```toml
[[sso.providers]]
id = "okta"
name = "Okta"
issuer = "https://example.okta.com"
client_id = "..."
client_secret_file = "/run/secrets/okta"
allowed_domains = ["example.com"]   # optional
create_users = true                 # make accounts for new people; otherwise they connect it first
```

Accounts are never matched by email address: people connect a provider to their account under **Account › Security**, or, with `create_users`, get an account when they first sign in. Accounts with two-factor sign-in still enter their code. For local testing, `make sso` runs [Dex](https://dexidp.io); see `deploy/dev-sso/dex.yaml`.

Each organization's Owners can then, under **Organization Settings › SSO**:
- **Require** one of these providers: the organization's pages, projects and API refuse sessions that didn't sign in through it, and access tokens made from them. To avoid locking yourself out, you have to be signed in with the provider to turn this on.
- **Let people join by signing in**: someone who signs in through the provider becomes a member, with the role chosen, if their email (as the provider vouches for it) is in the listed domains, or always if none are listed.

## Webhooks

Under **Organization Settings › Webhooks**, Owners can send the organization's events (what its audit log records: projects created or deleted, members joining, settings changed, ...) to URLs. Each event is one JSON POST, in order. Each request carries `X-Supermixer-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, made with the webhook's secret, and `X-Supermixer-Delivery`, which stays the same on retries. A receiver that fails is retried with backoff, holding later events back. The page has a test event button and each webhook's last 100 deliveries. Webhooks may only reach public addresses unless `[webhooks] allow_private_addresses = true`.

## API and access tokens

Scripts and CI use personal access tokens (**Account › Access Tokens**), sent as `Authorization: Bearer sbp_…`. A token acts as its owner, with the same roles in each organization, but can't change the account's password, two-factor sign-in, sessions or tokens; its uses are in the audit logs with its name.

- **Supermixer's API**, `/api/v1`: everything the app does. Its OpenAPI description is at `/api/v1/openapi.json`.
- **A Supabase-style Management API**, `/v1`: a subset of api.supabase.com/v1's paths and responses (organizations, projects, health, API keys, SQL, Edge Functions, function secrets, pause and restore, backups), for scripts written for Supabase's.

```sh
curl -X POST https://supermixer.example.com/v1/projects/<ref>/database/query \
  -H "Authorization: Bearer $SUPERMIXER_TOKEN" -H "Content-Type: application/json" \
  -d '{"query": "select count(*) from auth.users"}'
```

## Creating stacks

Besides connecting to Supabase stacks that already run, Supermixer can create them: **New project › Create a new stack**. It runs Supabase's official compose files (bundled at a pinned commit, see `backend/internal/provision/template/VERSION`) with the `docker compose` CLI, generates every secret, gives each stack its own ports, and can pause, restart and delete them from **Settings › Infrastructure**.

It is off by default, because control of the Docker daemon is root-equivalent on the host. To turn it on:

```toml
[provisioning]
enabled = true
stacks_dir = "/var/lib/supermixer/stacks"   # one folder per stack
backups_dir = "/var/lib/supermixer/backups" # database backups (Database › Backups)
public_host = "supabase.example.internal"   # the host name in stacks' URLs
```

- Running Supermixer in a container: create `stacks_dir` and `backups_dir` owned by your user first (`sudo install -d -o $(id -u) -g $(id -g) -m 700 /var/lib/supermixer/stacks /var/lib/supermixer/backups`), then `make app-stacks`. It mounts the Docker socket, and both folders at the same paths inside the container (Compose resolves the stacks' bind mounts on the host).
- Backups are Supabase-style dumps of each stack's database (roles, schema, data), taken every `backup_interval` and on demand; Storage files aren't included. To keep copies off the server, set `[provisioning.backup_s3]` (AWS S3, MinIO, Cloudflare R2 or another S3-compatible bucket): each backup is uploaded once it's taken, and with `keep_local = false` it then lives only in the bucket. Otherwise, back `backups_dir` up off the server yourself.
- Run one Supermixer server per metadata database when provisioning: operations on a stack are coordinated within a server. (A stuck create or delete is still noticed across servers: a running operation keeps its status fresh, and one left untouched for three minutes is marked failed.)
- Each stack takes one port from each of `api_ports`, `db_ports` and `pooler_ports`; widen them for more stacks.
- To update the bundled Supabase version, run `backend/internal/provision/sync-template.sh <commit>`, then the tests, and create a stack before committing.

## Running in production

### Several replicas

Supermixer keeps everything in its PostgreSQL database (sessions, sign-in challenges, audit log, settings), so replicas behind a load balancer are interchangeable; no sticky sessions are needed. Give every replica the same settings, above all `security.encryption_key`. Background work (scheduled backups, S3 uploads, audit log drains, recovering interrupted stack operations) runs on one replica at a time, which holds a Postgres advisory lock on its own connection; if it stops or loses that connection, another takes over within about 10 seconds (about half a minute if its machine dies outright, through TCP keepalives). The lock needs a session-level connection: point `database.url` at Postgres directly or at a pooler in session mode, not PgBouncer's transaction mode.

Two things are per replica: the sign-in rate limits (so N replicas allow up to N times as many attempts; put a rate limit in front as well if that matters), and creating stacks, which runs `docker compose` on the replica's own Docker host, so with provisioning on, run one replica.

### Kubernetes

`deploy/helm/supermixer` is a Helm chart: two replicas by default, the settings in a Secret, readiness on `/api/v1/health`, a PodDisruptionBudget, an optional Ingress and a ServiceMonitor for the Prometheus Operator. Build the image (`make image IMAGE=registry.example.com/supermixer`) and push it, then

```sh
helm install supermixer deploy/helm/supermixer \
  --set image.repository=registry.example.com/supermixer --set-file config=prod.env.toml
```

Provisioning isn't supported there; register existing stacks instead.

### Metrics

With `[metrics] listen = "127.0.0.1:9100"` (or `":9100"` in a pod), Prometheus metrics are at `/metrics` on that address, which isn't authenticated:

| Metric | |
|---|---|
| `supermixer_http_requests_total`, `supermixer_http_request_duration_seconds` | by method, route pattern and status |
| `supermixer_sign_ins_total` | by method (password, mfa, sso) and result |
| `supermixer_emails_total` | sent or failed |
| `supermixer_audit_drain_entries_total`, `_errors_total`, `_lag_entries` | per drain |
| `supermixer_users`, `_organizations`, `_projects`, `_stacks` | read from the database at each scrape |
| `supermixer_backup_last_success_timestamp_seconds`, `supermixer_backups_failed_last_day` | per stack, for alerts like `time() - supermixer_backup_last_success_timestamp_seconds > 2 * 86400` |

Counters are per replica; the database-backed gauges are the same on every replica, so use `max` rather than `sum` across them.

### Audit log drains

`[[audit.drains]]` sends each audit log entry elsewhere as it's written: `type = "http"` POSTs JSON arrays of entries to a URL (with any `headers`, such as Authorization), and `type = "file"` appends JSON lines for a log shipper. Delivery is in order and at least once: each drain's position is kept in the database, so restarts, failovers and outages of the receiver resume where they stopped (retrying with backoff, up to 5 minutes apart), and receivers can de-duplicate on `id`. A new drain starts with entries written after it's added. **Admin › Overview** shows each drain's backlog and last error.

## Layout

| Path | Contents |
|---|---|
| `api/openapi.yaml` | REST contract. Go handlers and the TypeScript client are generated from it. |
| `backend/` | Go server: chi, pgx, sqlc, goose. Its parts: `internal/config` (settings), `internal/store` (database), `internal/theme` (brand palette), `internal/httpapi` (HTTP). |
| `web/` | React 19 + Vite + TanStack Router/Query + Tailwind v4, with components ported from Supabase's UI library. |
| `deploy/` | Docker Compose for Supermixer and its database. |

Supermixer adapts design tokens and components from Supabase (Apache-2.0). See [NOTICE](NOTICE).
