-- name: AddRotationAdvisory :exec
INSERT INTO rotation_advisories (project_id, username, reason) VALUES ($1, $2, $3);

-- name: ListRotationAdvisories :many
SELECT * FROM rotation_advisories WHERE project_id = $1 ORDER BY created_at;

-- name: ClearRotationAdvisories :execrows
-- Those recorded before a time (a rotation's start: later ones may concern its new keys).
DELETE FROM rotation_advisories WHERE project_id = $1 AND created_at < sqlc.arg(before)::timestamptz;

-- name: AddDBSnapshot :one
INSERT INTO db_snapshots (project_id, reason, detail, taken_by, data) VALUES ($1, $2, $3, $4, $5)
RETURNING id, project_id, taken_at, reason, detail, taken_by;

-- name: ListDBSnapshots :many
SELECT id, project_id, taken_at, reason, detail, taken_by FROM db_snapshots
WHERE project_id = $1 ORDER BY taken_at DESC;

-- name: GetDBSnapshot :one
SELECT * FROM db_snapshots WHERE id = $1 AND project_id = $2;

-- name: PruneDBSnapshots :exec
-- Keeps a project's newest 20 snapshots taken before deploys. Manual ones
-- stay until the project goes, so deploys can't push a baseline out.
DELETE FROM db_snapshots d WHERE d.project_id = $1 AND d.reason = 'function_deploy' AND d.id NOT IN (
    SELECT k.id FROM db_snapshots k WHERE k.project_id = $1 AND k.reason = 'function_deploy'
    ORDER BY k.taken_at DESC LIMIT 20);

-- name: LatestDBSnapshotData :one
SELECT data FROM db_snapshots WHERE project_id = $1 ORDER BY taken_at DESC LIMIT 1;

-- name: RecordKeyRotations :exec
INSERT INTO key_rotations (project_id, key, started_at)
SELECT $1, unnest(sqlc.arg(keys)::text[]), sqlc.arg(started_at)::timestamptz
ON CONFLICT (project_id, key) DO UPDATE SET started_at = excluded.started_at;

-- name: ClearAnsweredRotationAdvisories :execrows
-- Advice older than the last rotation of every required key (none if one
-- of them was never rotated).
DELETE FROM rotation_advisories
WHERE rotation_advisories.project_id = sqlc.arg(project_id)
  AND created_at < (
    SELECT min(k.started_at) FROM key_rotations k
    WHERE k.project_id = sqlc.arg(project_id) AND k.key = ANY(sqlc.arg(required)::text[])
    HAVING count(*) = cardinality(sqlc.arg(required)::text[])
  );
