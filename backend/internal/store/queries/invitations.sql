-- name: CreateInvitation :one
INSERT INTO invitations (organization_id, token_hash, email, role, project_roles, invited_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: ListPendingInvitations :many
SELECT sqlc.embed(i), coalesce(u.username, '')::text AS invited_by_username
FROM invitations i
LEFT JOIN users u ON u.id = i.invited_by
WHERE i.organization_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now()
ORDER BY i.created_at DESC;

-- name: GetInvitationByTokenHash :one
SELECT sqlc.embed(i), o.slug AS organization_slug, o.name AS organization_name,
       coalesce(u.username, '')::text AS invited_by_username
FROM invitations i
JOIN organizations o ON o.id = i.organization_id
LEFT JOIN users u ON u.id = i.invited_by
WHERE i.token_hash = $1;

-- name: DeleteInvitation :execrows
DELETE FROM invitations WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL;

-- name: MarkInvitationAccepted :execrows
UPDATE invitations SET accepted_at = now(), accepted_by = $2
WHERE id = $1 AND accepted_at IS NULL AND expires_at > now();
