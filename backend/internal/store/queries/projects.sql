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
