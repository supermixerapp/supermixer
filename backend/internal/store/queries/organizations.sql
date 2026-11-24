-- name: CreateOrganization :one
INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING *;

-- name: OrganizationSlugExists :one
SELECT EXISTS (SELECT 1 FROM organizations WHERE slug = $1);

-- name: GetOrganizationBySlug :one
SELECT * FROM organizations WHERE slug = $1;

-- name: GetOrganizationByID :one
SELECT * FROM organizations WHERE id = $1;

-- name: ListOrganizationsForUser :many
SELECT sqlc.embed(o), m.role,
       (SELECT count(*) FROM projects p WHERE p.organization_id = o.id)::int AS project_count
FROM organizations o
JOIN org_members m ON m.organization_id = o.id
WHERE m.user_id = $1
ORDER BY o.name;

-- name: UpdateOrganization :one
UPDATE organizations SET name = $2, mfa_required = $3, updated_at = now() WHERE id = $1 RETURNING *;

-- name: DeleteOrganization :exec
DELETE FROM organizations WHERE id = $1;

-- name: CountOrganizationProjects :one
SELECT count(*) FROM projects WHERE organization_id = $1;

-- name: SetOrganizationSSO :one
UPDATE organizations SET sso_provider = sqlc.narg(sso_provider), sso_required = @sso_required,
    sso_join_role = sqlc.narg(sso_join_role), sso_join_domains = @sso_join_domains::text[], updated_at = now()
WHERE id = @id
RETURNING *;

-- name: ListSSOJoinOrganizations :many
-- Organizations people signing in through a provider join.
SELECT * FROM organizations WHERE sso_provider = $1 AND sso_join_role IS NOT NULL ORDER BY created_at;

