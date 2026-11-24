-- name: InsertAuditLog :exec
INSERT INTO audit_logs (organization_id, project_id, actor_id, actor_username, action, target_type,
                        target_id, target_name, metadata, ip, user_agent)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: ListAuditLogs :many
SELECT * FROM audit_logs
WHERE organization_id = @organization_id
  AND (sqlc.narg(action_prefix)::text IS NULL OR action LIKE sqlc.narg(action_prefix) || '%')
  AND (sqlc.narg(actor_id)::uuid IS NULL OR actor_id = sqlc.narg(actor_id))
  AND (sqlc.narg(since)::timestamptz IS NULL OR created_at >= sqlc.narg(since))
  AND (sqlc.narg(before_id)::bigint IS NULL OR id < sqlc.narg(before_id))
ORDER BY id DESC
LIMIT @row_limit;

-- name: ListInstanceAuditLogs :many
-- Entries outside any organization (accounts, sign-ins, instance settings).
SELECT * FROM audit_logs
WHERE organization_id IS NULL
  AND (sqlc.narg(action_prefix)::text IS NULL OR action LIKE sqlc.narg(action_prefix) || '%')
  AND (sqlc.narg(before_id)::bigint IS NULL OR id < sqlc.narg(before_id))
ORDER BY id DESC
LIMIT @row_limit;
