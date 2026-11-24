-- name: CreateBackup :one
INSERT INTO backups (project_id, kind, template, created_by)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: FinishBackup :one
UPDATE backups SET status = $2, error = $3, size_bytes = $4, postgres_version = $5, finished_at = now()
WHERE id = $1
RETURNING *;

-- name: ListBackups :many
SELECT * FROM backups WHERE project_id = $1 ORDER BY started_at DESC;

-- name: GetBackup :one
SELECT * FROM backups WHERE id = $1 AND project_id = $2;

-- name: DeleteBackup :exec
DELETE FROM backups WHERE id = $1;

-- name: LastScheduledBackup :one
-- When the stack's last scheduled backup started (failed ones count, so a
-- failing stack isn't retried every minute).
SELECT coalesce(max(started_at), 'epoch'::timestamptz)::timestamptz AS started_at
FROM backups WHERE project_id = $1 AND kind = 'scheduled';

-- name: OldScheduledBackups :many
-- Scheduled backups with this status beyond the newest keep, to remove.
SELECT * FROM backups
WHERE project_id = $1 AND kind = 'scheduled' AND status = sqlc.arg(status)::backup_status
ORDER BY started_at DESC
OFFSET sqlc.arg(keep)::int;

-- name: FailStaleBackups :many
-- Backups still running after the longest a backup may take: a restart (of
-- this server or another) cut them short. Returns them to remove their files.
UPDATE backups b SET status = 'failed', error = 'Supermixer stopped while the backup was running', finished_at = now()
FROM projects p
WHERE b.project_id = p.id AND b.status = 'running' AND b.started_at < sqlc.arg(before)::timestamptz
RETURNING b.id, p.ref;

-- name: ListRunningStacksForBackup :many
SELECT * FROM projects WHERE managed AND stack_status = 'running';
