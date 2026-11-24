# Supermixer developer tasks. Run `make help` for a list.
SHELL := /bin/bash
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.1.0-dev)
SQLC_IMAGE := sqlc/sqlc:1.29.0
COMPOSE := docker compose -f deploy/docker-compose.yml

.PHONY: help setup env app app-stacks db db-down mail dev dev-backend dev-web generate build test test-integration lint stack stack-down stack-check-logs

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: env ## Install dependencies and create .env.toml if missing
	cd web && pnpm install
	cd backend && go mod download

env: ## Create .env.toml from .env.example.toml with a fresh encryption key (never overwrites)
	@if [ -d .env.toml ]; then echo ".env.toml is a directory (Docker makes one when it mounts a missing file). Delete it, then run make env again." >&2; exit 1; \
	elif [ -f .env.toml ]; then echo ".env.toml already exists, leaving it alone"; \
	else key=$$(openssl rand -base64 32); \
		sed 's|^encryption_key = ""$$|encryption_key = "'"$$key"'"|' .env.example.toml > .env.toml; \
		chmod 600 .env.toml; \
		echo "created .env.toml"; fi

app: ## Run Supermixer and its Postgres in containers (reads .env.toml)
	@test -f .env.toml || { echo "no .env.toml; run make env first" >&2; exit 1; }
	SUPERMIXER_UID=$$(id -u) SUPERMIXER_GID=$$(id -g) $(COMPOSE) --profile app up -d --build

# provisioning.stacks_dir from .env.toml (its default if unset).
STACKS_DIR = $(shell awk -F'"' '/^\[/{s=($$0 ~ /^\[provisioning\]/)} s && /^[ \t]*stacks_dir[ \t]*=/{print $$2; exit}' .env.toml 2>/dev/null)
# provisioning.backups_dir likewise.
BACKUPS_DIR = $(shell awk -F'"' '/^\[/{s=($$0 ~ /^\[provisioning\]/)} s && /^[ \t]*backups_dir[ \t]*=/{print $$2; exit}' .env.toml 2>/dev/null)

app-stacks: ## Like app, but the container may create Supabase stacks (Docker socket; see deploy/docker-compose.provisioning.yml)
	@test -f .env.toml || { echo "no .env.toml; run make env first" >&2; exit 1; }
	@for dir in "$(or $(STACKS_DIR),/var/lib/supermixer/stacks)" "$(or $(BACKUPS_DIR),/var/lib/supermixer/backups)"; do \
	test -d "$$dir" -a -w "$$dir" || { \
	  echo "the folder $$dir must exist and be writable by $$(id -un); for example:" >&2; \
	  echo "  sudo install -d -o $$(id -u) -g $$(id -g) -m 700 $$dir" >&2; exit 1; }; done
	SUPERMIXER_UID=$$(id -u) SUPERMIXER_GID=$$(id -g) \
	SUPERMIXER_STACKS_DIR="$(or $(STACKS_DIR),/var/lib/supermixer/stacks)" \
	SUPERMIXER_BACKUPS_DIR="$(or $(BACKUPS_DIR),/var/lib/supermixer/backups)" \
	DOCKER_GID=$$(stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock) \
	$(COMPOSE) -f deploy/docker-compose.provisioning.yml --profile app up -d --build

db: ## Start Supermixer's Postgres (port 5433)
	$(COMPOSE) up -d --wait db

mail: ## Start Mailpit, a mail server that keeps what it's sent (SMTP :1025, read at http://localhost:8025)
	$(COMPOSE) --profile mail up -d --wait mailpit

db-down: ## Stop Supermixer's Postgres and Mailpit (data is kept)
	$(COMPOSE) --profile mail down

dev: db ## Run the API (live reload, :8080) and the web app (Vite, :5173)
	@trap 'kill 0' EXIT; \
	$(MAKE) --no-print-directory dev-backend & \
	$(MAKE) --no-print-directory dev-web & \
	wait

dev-backend:
	cd backend && go tool air

dev-web:
	cd web && pnpm dev

stack: ## Start a dev self-hosted Supabase stack to register as a project (API :8100)
	deploy/dev-stacks/up.sh

stack-down: ## Stop the dev Supabase stack (data is kept)
	deploy/dev-stacks/down.sh

stack-check-logs: ## Check the dev stack's Logs get its own logs and no other container's
	deploy/dev-stacks/check-logs.sh

generate: ## Regenerate code from api/openapi.yaml and SQL queries
	cd backend && go generate ./...
	cd backend && docker run --rm -v "$$PWD":/src -w /src $(SQLC_IMAGE) generate
	cd web && pnpm generate:api

build: ## Build a single binary with the web UI embedded (bin/supermixer)
	cd web && pnpm build
	rsync -a --delete --exclude .gitkeep web/dist/ backend/internal/webui/dist/
	cd backend && CGO_ENABLED=0 go build -trimpath \
		-ldflags "-s -w -X supermixer/internal/version.Version=$(VERSION)" \
		-o ../bin/supermixer ./cmd/supermixer
	@echo "built bin/supermixer ($(VERSION))"

test: ## Run Go and web tests (integration tests skip if Postgres isn't running)
	cd backend && go test ./...
	cd web && pnpm test
	python3 -m unittest discover -s deploy/dev-stacks -p 'test_*.py'

test-integration: db ## Start Postgres, then run all Go tests including integration
	cd backend && go test -count=1 ./...

lint: ## Vet, lint and type-check
	cd backend && go vet ./...
	@if command -v golangci-lint >/dev/null; then cd backend && golangci-lint run; else echo "golangci-lint not installed, skipped"; fi
	cd web && pnpm lint && pnpm typecheck
