-- name: CreateWebhook :one
-- Starts after the organization's entries already there.
INSERT INTO org_webhooks (organization_id, kind, url, description, events, secret, created_by, last_txid, last_id)
SELECT @organization_id, @kind, @url, @description, @events::text[], @secret, @created_by,
       coalesce(max(txid), 0), coalesce(max(id), 0)
FROM audit_logs
RETURNING *;

-- name: ListWebhooks :many
SELECT * FROM org_webhooks WHERE organization_id = $1 ORDER BY created_at;

-- name: GetWebhook :one
SELECT * FROM org_webhooks WHERE id = $1 AND organization_id = $2;

-- name: UpdateWebhook :one
UPDATE org_webhooks SET url = @url, description = @description, events = @events::text[], enabled = @enabled,
    -- A chat channel's new address (sealed); NULL keeps it.
    secret = coalesce(sqlc.narg(secret), org_webhooks.secret),
    -- Turning it back on starts afresh rather than sending what it missed.
    last_txid = CASE WHEN @enabled AND NOT org_webhooks.enabled THEN (SELECT coalesce(max(a.txid), 0) FROM audit_logs a) ELSE org_webhooks.last_txid END,
    last_id = CASE WHEN @enabled AND NOT org_webhooks.enabled THEN (SELECT coalesce(max(a.id), 0) FROM audit_logs a) ELSE org_webhooks.last_id END,
    -- Turning it back on, or a new address, starts without the old failure
    -- (and the delivery loop drops its backoff when failing_since clears).
    last_error = CASE WHEN (@enabled AND NOT org_webhooks.enabled) OR @url <> org_webhooks.url OR sqlc.narg(secret)::bytea IS NOT NULL
        THEN '' ELSE org_webhooks.last_error END,
    failing_since = CASE WHEN (@enabled AND NOT org_webhooks.enabled) OR @url <> org_webhooks.url OR sqlc.narg(secret)::bytea IS NOT NULL
        THEN NULL ELSE org_webhooks.failing_since END
WHERE org_webhooks.id = @id AND org_webhooks.organization_id = @organization_id
RETURNING *;

-- name: SetWebhookSecret :exec
UPDATE org_webhooks SET secret = $2 WHERE id = $1;

-- name: DeleteWebhook :one
DELETE FROM org_webhooks WHERE id = $1 AND organization_id = $2 RETURNING *;

-- name: ListEnabledWebhooks :many
SELECT sqlc.embed(w), o.slug AS organization_slug, o.name AS organization_name
FROM org_webhooks w JOIN organizations o ON o.id = w.organization_id
WHERE w.enabled ORDER BY w.id;

-- name: WebhookEntriesAfter :many
-- The organization's entries after the position, from finished transactions.
SELECT a.id, a.txid, a.action, a.actor_id, a.actor_username, a.target_type, a.target_id, a.target_name,
       a.metadata, a.created_at, p.ref AS project_ref
FROM audit_logs a
LEFT JOIN projects p ON p.id = a.project_id
WHERE a.organization_id = @organization_id
  AND (a.txid, a.id) > (@last_txid::bigint, @last_id::bigint)
  AND a.txid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
ORDER BY a.txid, a.id
LIMIT @row_limit;

-- name: AdvanceWebhook :exec
UPDATE org_webhooks SET last_txid = @last_txid, last_id = @last_id
WHERE id = @id AND (last_txid, last_id) < (@last_txid::bigint, @last_id::bigint);

-- name: WebhookSucceeded :exec
UPDATE org_webhooks SET last_success_at = now(), last_error = '', failing_since = NULL WHERE id = $1;

-- name: WebhookFailed :exec
UPDATE org_webhooks SET last_error = $2, failing_since = coalesce(failing_since, now()) WHERE id = $1;

-- name: AddWebhookDelivery :exec
INSERT INTO org_webhook_deliveries (webhook_id, event_id, event, status, error, duration_ms)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: PruneWebhookDeliveries :exec
DELETE FROM org_webhook_deliveries d
WHERE d.webhook_id = $1
  AND d.id < (SELECT min(id) FROM (SELECT id FROM org_webhook_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT 100) newest);

-- name: ListWebhookDeliveries :many
SELECT * FROM org_webhook_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT 100;
