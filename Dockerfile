# Builds the single Supermixer binary with the web UI embedded.

FROM node:24-alpine AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY api /src/api
COPY web ./
RUN pnpm build

FROM golang:1.26-alpine AS backend
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend ./
COPY --from=web /src/web/dist ./internal/webui/dist
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X supermixer/internal/version.Version=${VERSION}" \
    -o /out/supermixer ./cmd/supermixer

# Alpine rather than distroless: creating Supabase stacks (provisioning) runs
# the docker CLI with its compose plugin. Still a non-root user (65532).
FROM alpine:3.22
RUN apk add --no-cache ca-certificates docker-cli docker-cli-compose \
 && adduser -D -H -u 65532 nonroot
COPY --from=backend /out/supermixer /usr/local/bin/supermixer
USER 65532:65532
# 8080: the app; 9100: Prometheus metrics, if [metrics] listen = ":9100".
EXPOSE 8080 9100
# Reads /etc/supermixer/.env.toml if it is mounted; any setting can also come
# from SUPERMIXER_* environment variables (see .env.example.toml).
WORKDIR /etc/supermixer
ENTRYPOINT ["/usr/local/bin/supermixer"]
