-- name: EnsureAuditDrain :exec
-- A drain seen for the first time starts after the entries already there.
INSERT INTO audit_drains (id, last_txid, last_id)
SELECT $1, coalesce(max(txid), 0), coalesce(max(id), 0) FROM audit_logs
ON CONFLICT (id) DO NOTHING;

-- name: GetAuditDrain :one
SELECT * FROM audit_drains WHERE id = $1;

-- name: AuditLogsAfter :many
-- Entries after the position, from transactions that have all finished.
SELECT a.id, a.txid, a.action, a.actor_id, a.actor_username, a.target_type, a.target_id, a.target_name,
       a.metadata, a.ip, a.user_agent, a.created_at, o.slug AS organization_slug, p.ref AS project_ref
FROM audit_logs a
LEFT JOIN organizations o ON o.id = a.organization_id
LEFT JOIN projects p ON p.id = a.project_id
WHERE (a.txid, a.id) > (@last_txid::bigint, @last_id::bigint)
  AND a.txid < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
ORDER BY a.txid, a.id
LIMIT @row_limit;

-- name: AuditDrainLag :one
SELECT count(*)::bigint FROM audit_logs WHERE (txid, id) > (@last_txid::bigint, @last_id::bigint);

-- name: AdvanceAuditDrain :exec
UPDATE audit_drains SET last_txid = @last_txid, last_id = @last_id, last_success_at = now(), last_error = ''
WHERE id = @id AND (last_txid, last_id) < (@last_txid::bigint, @last_id::bigint);

-- name: AuditDrainFailed :exec
UPDATE audit_drains SET last_error = $2, last_error_at = now() WHERE id = $1;

-- name: StacksByStatus :many
SELECT stack_status::text AS status, count(*)::int AS n FROM projects WHERE managed GROUP BY stack_status;

-- name: LastCompletedBackups :many
SELECT p.ref, max(b.finished_at)::timestamptz AS finished_at
FROM backups b JOIN projects p ON p.id = b.project_id
WHERE b.status = 'completed' AND b.finished_at IS NOT NULL
GROUP BY p.ref;

-- name: FailedBackupsLastDay :many
SELECT p.ref, count(*)::int AS n
FROM backups b JOIN projects p ON p.id = b.project_id
WHERE b.status = 'failed' AND b.started_at > now() - interval '1 day'
GROUP BY p.ref;

