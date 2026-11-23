-- name: AddMember :execrows
INSERT INTO org_members (organization_id, user_id, role) VALUES ($1, $2, $3)
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- name: GetMemberRole :one
SELECT role FROM org_members WHERE organization_id = $1 AND user_id = $2;

-- name: ListMembers :many
SELECT m.role, m.created_at AS joined_at, sqlc.embed(u)
FROM org_members m
JOIN users u ON u.id = m.user_id
WHERE m.organization_id = $1
ORDER BY u.username;

-- name: UpdateMemberRole :exec
UPDATE org_members SET role = $3 WHERE organization_id = $1 AND user_id = $2;

-- name: RemoveMember :exec
DELETE FROM org_members WHERE organization_id = $1 AND user_id = $2;

-- name: CountOwners :one
SELECT count(*) FROM org_members WHERE organization_id = $1 AND role = 'owner';

-- name: ListOrganizationProjectRoles :many
SELECT r.user_id, r.role, p.id AS project_id, p.ref, p.name
FROM project_member_roles r
JOIN projects p ON p.id = r.project_id
WHERE p.organization_id = $1
ORDER BY p.name;

-- name: ListUserProjectRoles :many
SELECT r.project_id, r.role FROM project_member_roles r WHERE r.user_id = $1;

-- name: SetProjectRole :exec
INSERT INTO project_member_roles (project_id, user_id, role) VALUES ($1, $2, $3)
ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role;

-- name: DeleteMemberProjectRoles :exec
DELETE FROM project_member_roles r
USING projects p
WHERE p.id = r.project_id AND p.organization_id = $1 AND r.user_id = $2;

-- name: DeleteProjectRoles :exec
DELETE FROM project_member_roles WHERE project_id = $1;
