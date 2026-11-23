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

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend /out/supermixer /usr/local/bin/supermixer
EXPOSE 8080
# Configuration comes from the environment (compose passes the .env file).
ENTRYPOINT ["/usr/local/bin/supermixer", "--env-file", ""]
