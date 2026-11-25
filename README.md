# Supermixer

An on-premise management plane for self-hosted Supabase: organizations, projects, users and access control, in a console that looks and works like supabase.com/dashboard.

## What it does

After signing in you land on your organization's projects (or the list of organizations, if you're in several). From there, much as on supabase.com/dashboard:

- **Organizations:** projects (as cards or a list) with live health, a team with Supabase's roles (Owner, Administrator, Developer, Read-only, or chosen projects only), invitations, usage, an audit log, and settings: General, Security (require two-factor sign-in), SSO and Webhooks.
- **Projects:** connect a self-hosted Supabase stack that's already running, or have Supermixer create one ([Creating stacks](#creating-stacks)). Each project has:
  - Table Editor and SQL Editor, with saved snippets; Read-only members run SQL read-only
  - Database: tables, functions, triggers, types, extensions, indexes, publications, policies, roles, column privileges, a schema visualizer, migrations, settings and backups
  - Authentication: users and policies, plus the Auth settings of created stacks (providers, emails, sessions, rate limits, MFA, URLs, attack protection, hooks)
  - Storage: buckets and files, policies, and for created stacks its settings and S3 connection
  - Edge Functions (deployed and edited on created stacks), and the Realtime inspector and policies
  - Advisors (Supabase's security and performance lints, query performance, and Changes: snapshots of what could keep an intruder in), Observability reports and Logs
  - Integrations: Data API docs, GraphQL, Cron, Queues, Vault, database webhooks and foreign data wrappers
  - Settings: general, infrastructure, API keys (secret ones shown only to roles allowed to see them), JWT keys and log drains
- **Your account:** name, email and password, sessions, two-factor sign-in, connected sign-in providers, access tokens, light or dark appearance, and your own audit log.
- **Instance admins:** an Instance console ([Instance administration](#instance-administration)).

Organization **OAuth Apps** and **Integrations** (such as GitHub) say "Coming soon".

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
| `make e2e` | End-to-end tests in your installed Chrome (Playwright). The walk-through covers first sign-in, an organization, registering the dev stack (`make stack` first), the projects' grid and list views, a Read-only member who can't see keys or change settings, a global notice, the audit log, a webhook receiving signed events, the organization Security page, the Storage pages, and that nothing loads from outside Supermixer, then compares key pages with screenshots in light and dark. Other tests: `brand_color` taking effect on restart, and per-organization SSO through Dex if `make sso` is running. Uses its own Supermixer (:8091), web app (:5176) and `supermixer_e2e` database, so `make dev` is untouched. A failure leaves a trace in `web/test-results/`; `make e2e ARGS=--update-snapshots` accepts new screenshots |
| `make stack` / `make stack-down` | Start or stop a dev self-hosted Supabase stack; it can run next to other Supabase stacks |
| `make lint` | go vet, ESLint and the TypeScript type check |
| `make generate` | Regenerates code after editing `api/openapi.yaml` or SQL queries |
| `make app` | Runs Supermixer and its database in containers, reading `.env.toml` |
| `make app-stacks` | Like `make app`, but the container may create Supabase stacks (see below) |
| `make stack-check-logs` | Checks the dev stack's Logs pages get its own logs and no other container's |
| `make db` / `make db-down` | Start Supermixer's own Postgres (port 5433), or stop it along with Mailpit and Dex (data is kept) |
| `make mail` | Mailpit, for trying email ([Email](#email)) |
| `make sso` | Dex, for trying single sign-on ([Single sign-on](#single-sign-on)) |
| `make env` | Creates `.env.toml` with a fresh encryption key, if it doesn't exist (`make setup` does this too) |
| `make image` / `make helm-lint` | Build the container image; check the Helm chart ([Kubernetes](#kubernetes)) |

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

Two-factor sign-in uses an authenticator app's codes, with recovery codes as a fallback; each person turns it on under **Account › Security**. An organization's Owners can require it of every member under **Organization Settings › Security**.

## Instance administration

The first account, `admin`, is an instance admin, and can make others instance admins. They get **Instance** in the account menu:

- **Overview:** counts of users, organizations and projects; the server's settings; audit log drains and their backlog; and a test email.
- **Users:** create accounts, reset passwords or two-factor sign-in, sign accounts out, disable them, and make instance admins.
- **Global notice:** a message for everyone signed in, such as planned downtime, shown as a band above the header on every page. Choose Info, Warning or Critical and write up to 256 characters; `**bold**` and `[links](https://example.com)` work, linking to `https://`, `http://`, `mailto:` or a page in Supermixer such as `/account/security`. It reaches open pages within a minute and stays until an instance admin takes it down.
- **Audit log:** everything recorded across the instance.

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

**GitHub** works too, through an OAuth App (GitHub › Settings › Developer settings › OAuth Apps). It reads only the account's verified email address and its user ID:

```toml
[[sso.providers]]
id = "github"
name = "GitHub"
type = "github"
client_id = "..."
client_secret_file = "/run/secrets/github"
# github_url = "https://github.example.com"   # GitHub Enterprise Server
```

Someone new signing in with GitHub gets an account only while **Instance › Sign-up** is on, with its allowed domains and approval; `create_users` isn't used. People who already have an account connect GitHub under **Account › Security**.

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

Because Supermixer holds a created stack's files, it can also change them, where for a connected stack you would edit its `.env` and compose files yourself:

- **Supabase upgrades** to the version bundled with Supermixer (**Settings › Infrastructure**), rolled back if they fail.
- **Edge Functions:** deploy and edit functions, keep earlier versions to restore, and set their secrets.
- **Auth settings** (**Authentication › Configuration**) and **Storage settings** (upload size limit, image transformations), applied by restarting just that service.
- **S3 connection** (**Storage › S3 Connection**): the endpoint, region and keys for S3 clients.
- **Key rotation** (**Settings › API Keys**): new API keys, JWT secret or signing key, S3 keys or the Edge Functions' database password. When someone who could see a project's keys leaves or loses access, its admins are told to rotate them; the notice goes once the secret key, the JWT secret and the S3 keys are all new.
- **Backups and log drains** (**Database › Backups**, **Settings › Log Drains**).

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

`[[audit.drains]]` sends each audit log entry elsewhere as it's written: `type = "http"` POSTs JSON arrays of entries to a URL (with any `headers`, such as Authorization), and `type = "file"` appends JSON lines for a log shipper. Delivery is in order and at least once: each drain's position is kept in the database, so restarts, failovers and outages of the receiver resume where they stopped (retrying with backoff, up to 5 minutes apart), and receivers can de-duplicate on `id`. A new drain starts with entries written after it's added. **Instance › Overview** shows each drain's backlog and last error.

## Layout

| Path | Contents |
|---|---|
| `api/openapi.yaml` | REST contract. Go handlers and the TypeScript client are generated from it. |
| `backend/` | Go server: chi, pgx, sqlc, goose. Under `internal/`: `httpapi` (the API), `store` (database, migrations and queries), `auth`, `rbac` (roles), `secrets` (encrypting stack credentials), `stack` (talking to a project's stack), `provision` (creating and changing stacks), `advisors`, `mail`, `metrics`, `theme` (brand palette), `config` and `bootstrap` (the first admin). |
| `web/` | React 19 + Vite + TanStack Router/Query + Tailwind v4, with components ported from Supabase's UI library. End-to-end tests and their screenshots are in `web/e2e/`. |
| `deploy/` | Docker Compose for Supermixer and its database (`docker-compose.provisioning.yml` for creating stacks), the Helm chart (`helm/`), the dev Supabase stack (`dev-stacks/`) and Dex (`dev-sso/`). |

## License

Supermixer is released under the [Apache License 2.0](LICENSE). It adapts design tokens and components from Supabase, also Apache-2.0, and bundles a few other files under their own licences; see [NOTICE](NOTICE). Supabase is a trademark of Supabase, Inc.; Supermixer is not affiliated with or endorsed by Supabase.
