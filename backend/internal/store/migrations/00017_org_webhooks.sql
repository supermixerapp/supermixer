-- +goose Up
-- Organizations' outgoing webhooks: the organization's audit log entries,
-- POSTed one at a time, in order, signed with the webhook's secret. Like
-- audit drains, each keeps its position in the audit log (entries after
-- (last_txid, last_id) are still to send).
CREATE TABLE org_webhooks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    url             text NOT NULL,
    description     text NOT NULL DEFAULT '',
    -- Action prefixes to send ("project.", "member."), or {"*"} for all.
    events          text[] NOT NULL,
    secret          bytea NOT NULL, -- sealed
    enabled         boolean NOT NULL DEFAULT true,
    created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_txid       bigint NOT NULL,
    last_id         bigint NOT NULL,
    last_success_at timestamptz,
    last_error      text NOT NULL DEFAULT '',
    failing_since   timestamptz
);
CREATE INDEX org_webhooks_org_idx ON org_webhooks (organization_id);

-- Recent attempts, for the settings page (the newest 100 per webhook).
CREATE TABLE org_webhook_deliveries (
    id          bigserial PRIMARY KEY,
    webhook_id  uuid NOT NULL REFERENCES org_webhooks (id) ON DELETE CASCADE,
    event_id    bigint NOT NULL, -- the audit log entry; 0 for a test event
    event       text NOT NULL,
    status      int NOT NULL DEFAULT 0, -- HTTP status; 0 if there was none
    error       text NOT NULL DEFAULT '',
    duration_ms int NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_webhook_deliveries_webhook_idx ON org_webhook_deliveries (webhook_id, id DESC);

-- +goose Down
DROP TABLE org_webhook_deliveries;
DROP TABLE org_webhooks;
