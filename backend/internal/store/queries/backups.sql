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

-- name: PendingUploads :many
-- Completed backups with files here and no copy in the bucket yet, after a
-- failed upload waiting 2, 4, 8 ... minutes (an hour at most) between tries.
SELECT sqlc.embed(b), p.ref FROM backups b JOIN projects p ON p.id = b.project_id
WHERE b.status = 'completed' AND b.local AND b.uploaded_at IS NULL
  AND (b.upload_attempted_at IS NULL
       OR b.upload_attempted_at < now() - make_interval(mins => least(power(2, least(b.upload_attempts, 6))::int, 60)))
ORDER BY b.started_at
LIMIT 20;

-- name: MarkBackupUploaded :one
UPDATE backups SET remote_bucket = $2, remote_key = $3, uploaded_at = now(), upload_error = ''
WHERE id = $1
RETURNING *;

-- name: MarkBackupUploadFailed :exec
UPDATE backups SET upload_error = $2, upload_attempts = upload_attempts + 1, upload_attempted_at = now()
WHERE id = $1;

-- name: SetBackupLocal :exec
UPDATE backups SET local = $2 WHERE id = $1;

-- name: UploadedLocalBackups :many
-- Backups both here and in this bucket, to remove here when keep_local is
-- off (not those in another bucket, which Supermixer can no longer read).
SELECT sqlc.embed(b), p.ref FROM backups b JOIN projects p ON p.id = b.project_id
WHERE b.local AND b.uploaded_at IS NOT NULL AND b.remote_bucket = sqlc.arg(bucket);

-- name: ListProjectRemoteBackups :many
-- A project's backups with a copy in a bucket (to remove when it's deleted).
SELECT * FROM backups WHERE project_id = $1 AND uploaded_at IS NOT NULL;

-- name: RetryBackupUpload :one
-- Upload at the next chance, not after the wait (shown as uploading meanwhile).
UPDATE backups SET upload_attempted_at = NULL, upload_error = '' WHERE id = $1 AND project_id = $2
RETURNING *;

-- name: AddBackupLeftover :exec
INSERT INTO backup_leftovers (bucket, key) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: ListBackupLeftovers :many
SELECT * FROM backup_leftovers WHERE bucket = $1 ORDER BY created_at LIMIT 100;

-- name: DeleteBackupLeftover :exec
DELETE FROM backup_leftovers WHERE bucket = $1 AND key = $2;
