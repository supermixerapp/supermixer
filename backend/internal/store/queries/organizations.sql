-- name: CreateOrganization :one
INSERT INTO organizations (slug, name, created_by) VALUES ($1, $2, $3) RETURNING *;

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


-- Resource limits.

-- name: LockUserForLimits :one
-- Serializes a person's organization creations, so two at once can't both
-- pass the per-person limit.
SELECT id FROM users WHERE id = $1 FOR UPDATE;

-- name: CountOrganizationsCreatedBy :one
SELECT count(*) FROM organizations WHERE created_by = $1;

-- name: LockOrganizationForLimits :one
-- Serializes project additions to an organization (see LockUserForLimits),
-- returning its own project limit as it stands.
SELECT max_projects FROM organizations WHERE id = $1 FOR UPDATE;

-- name: SetOrganizationMaxProjects :exec
UPDATE organizations SET max_projects = $2, updated_at = now() WHERE id = $1;

-- name: MostOrganizationsCreatedByOnePerson :one
SELECT coalesce(max(n), 0)::bigint FROM (
    SELECT count(*) AS n FROM organizations WHERE created_by IS NOT NULL GROUP BY created_by
) t;

-- name: MostProjectsInOneOrganization :one
SELECT coalesce(max(n), 0)::bigint FROM (
    SELECT count(*) AS n FROM projects GROUP BY organization_id
) t;
