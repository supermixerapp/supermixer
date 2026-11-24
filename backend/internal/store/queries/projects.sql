-- name: CreateProject :one
INSERT INTO projects (ref, organization_id, name, api_url, studio_url, db_host, db_port, db_name, db_user,
                      db_sslmode, secrets, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: ProjectRefExists :one
SELECT EXISTS (SELECT 1 FROM projects WHERE ref = $1);

-- name: GetProjectByRef :one
SELECT sqlc.embed(p), o.slug AS organization_slug, o.name AS organization_name
FROM projects p
JOIN organizations o ON o.id = p.organization_id
WHERE p.ref = $1;

-- name: ListProjectsInOrganizations :many
SELECT sqlc.embed(p), o.slug AS organization_slug, o.name AS organization_name
FROM projects p
JOIN organizations o ON o.id = p.organization_id
WHERE p.organization_id = ANY(@organization_ids::uuid[])
ORDER BY p.name;

-- name: ListProjectsByOrganization :many
SELECT * FROM projects WHERE organization_id = $1 ORDER BY name;

-- name: UpdateProject :one
UPDATE projects
SET name = $2, api_url = $3, studio_url = $4, db_host = $5, db_port = $6, db_name = $7,
    db_user = $8, db_sslmode = $9, secrets = $10, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: MoveProject :exec
UPDATE projects SET organization_id = $2, updated_at = now() WHERE id = $1;

-- name: DeleteProject :exec
DELETE FROM projects WHERE id = $1;

-- name: SetProjectStack :one
UPDATE projects
SET managed = true, stack_status = $2, stack_error = '', stack_status_at = now(), stack_template = $3,
    stack_api_port = $4, stack_db_port = $5, stack_pooler_port = $6, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: SetStackStatus :one
UPDATE projects SET stack_status = $2, stack_error = $3, stack_status_at = now(), updated_at = now()
WHERE id = $1 AND managed
RETURNING *;

-- name: ListStackPorts :many
SELECT stack_api_port, stack_db_port, stack_pooler_port FROM projects WHERE managed;

-- name: ListStacksWithStatus :many
-- Stacks in one of these statuses whose status hasn't changed (or been
-- touched by a running operation) since before. Compared as text: pgx can't
-- send an array of the stack_status enum.
SELECT * FROM projects
WHERE managed AND stack_status::text = ANY(sqlc.arg(statuses)::text[])
  AND (stack_status_at IS NULL OR stack_status_at < sqlc.arg(before)::timestamptz);

-- name: TouchStack :exec
-- A running operation's heartbeat, so other servers don't think it's stuck.
UPDATE projects SET stack_status_at = now() WHERE id = $1 AND managed;

-- name: SetStackTemplate :exec
-- After an upgrade: the template the stack's files now come from.
UPDATE projects SET stack_template = $2 WHERE id = $1 AND managed;
