# Supermixer

An on-premise management plane for self-hosted Supabase: organizations, projects, users and access control, in a console that looks and works like supabase.com/dashboard.

**Status: Stage 1** (identity, organizations, projects, access control). You can sign in, create organizations, invite a team with Supabase's roles, and register running self-hosted Supabase stacks as projects with live health checks. Pages for later stages show which stage brings them.

## Requirements

- Go 1.24 or newer. The module needs Go 1.26, which Go downloads automatically.
- Node 24 and pnpm 10
- Docker, for Supermixer's own Postgres (`make dev`, `make test-integration`), `make generate`, and the dev Supabase stack (`make stack`, about 3 GB of images)

## Getting started

```sh
make setup   # install dependencies; creates .env with a fresh encryption key
make dev     # starts Postgres (port 5433), the API (:8080, live reload) and Vite (:5173)
```

Open http://localhost:5173 and sign in as `admin` / `admin` (from `.env`). Change the password right away; a banner reminds you until you do.

To try project registration against a real stack:

```sh
make stack   # starts a self-hosted Supabase on :8100 (first run downloads ~3 GB) and prints its details
```

Then use **New project** in Supermixer. **Fill from .env** fills the form from a pasted stack `.env`; for this stack that's `deploy/dev-stacks/.stack/.env`.

## Common tasks

| Command | What it does |
|---|---|
| `make build` | Single binary with the web UI embedded, written to `bin/supermixer` |
| `make test` | Go and web tests; integration tests are skipped if Postgres isn't running |
| `make test-integration` | Starts Postgres, then runs every Go test |
| `make stack` / `make stack-down` | Start or stop a dev self-hosted Supabase stack; it can run next to other Supabase stacks |
| `make lint` | go vet, ESLint and the TypeScript type check |
| `make generate` | Regenerates code after editing `api/openapi.yaml` or SQL queries |
| `docker compose -f deploy/docker-compose.yml --profile app up -d --build` | Runs everything in containers |

All settings are documented in [.env.example](.env.example). To re-theme the whole UI, change `BRAND_COLOR` and restart; no rebuild is needed.

## Layout

| Path | Contents |
|---|---|
| `api/openapi.yaml` | REST contract. Go handlers and the TypeScript client are generated from it. |
| `backend/` | Go server: chi, pgx, sqlc, goose. Its parts: `internal/config` (settings), `internal/store` (database), `internal/theme` (brand palette), `internal/httpapi` (HTTP). |
| `web/` | React 19 + Vite + TanStack Router/Query + Tailwind v4, with components ported from Supabase's UI library. |
| `deploy/` | Docker Compose for Supermixer and its database. |

Supermixer adapts design tokens and components from Supabase (Apache-2.0). See [NOTICE](NOTICE).
