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

Open http://localhost:5173 and sign in as `admin` / `admin` (from `.env.toml`). Change the password right away; a banner reminds you until you do.

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

## Creating stacks

Besides connecting to Supabase stacks that already run, Supermixer can create them: **New project › Create a new stack**. It runs Supabase's official compose files (bundled at a pinned commit, see `backend/internal/provision/template/VERSION`) with the `docker compose` CLI, generates every secret, gives each stack its own ports, and can pause, restart and delete them from **Settings › Infrastructure**.

It is off by default, because control of the Docker daemon is root-equivalent on the host. To turn it on:

```toml
[provisioning]
enabled = true
stacks_dir = "/var/lib/supermixer/stacks"   # one folder per stack
public_host = "supabase.example.internal"   # the host name in stacks' URLs
```

- Running Supermixer in a container: create `stacks_dir` owned by your user first (`sudo install -d -o $(id -u) -g $(id -g) -m 750 /var/lib/supermixer/stacks`), then `make app-stacks`. It mounts the Docker socket, and `stacks_dir` at the same path inside the container (Compose resolves the stacks' bind mounts on the host).
- Run one Supermixer server per metadata database when provisioning: operations on a stack are coordinated within a server. (A stuck create or delete is still noticed across servers: a running operation keeps its status fresh, and one left untouched for three minutes is marked failed.)
- Each stack takes one port from each of `api_ports`, `db_ports` and `pooler_ports`; widen them for more stacks.
- To update the bundled Supabase version, run `backend/internal/provision/sync-template.sh <commit>`, then the tests, and create a stack before committing.

## Layout

| Path | Contents |
|---|---|
| `api/openapi.yaml` | REST contract. Go handlers and the TypeScript client are generated from it. |
| `backend/` | Go server: chi, pgx, sqlc, goose. Its parts: `internal/config` (settings), `internal/store` (database), `internal/theme` (brand palette), `internal/httpapi` (HTTP). |
| `web/` | React 19 + Vite + TanStack Router/Query + Tailwind v4, with components ported from Supabase's UI library. |
| `deploy/` | Docker Compose for Supermixer and its database. |

Supermixer adapts design tokens and components from Supabase (Apache-2.0). See [NOTICE](NOTICE).
