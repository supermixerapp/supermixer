-- name: CreateAccessToken :one
INSERT INTO access_tokens (user_id, name, token_hash, prefix, expires_at, sso_provider) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: ListAccessTokens :many
SELECT * FROM access_tokens WHERE user_id = $1 ORDER BY created_at DESC;

-- name: DeleteAccessToken :one
DELETE FROM access_tokens WHERE id = $1 AND user_id = $2 RETURNING *;

-- name: DeleteUserAccessTokens :exec
DELETE FROM access_tokens WHERE user_id = $1;

-- name: GetActiveAccessToken :one
-- A token that works: not expired, and its owner not disabled.
SELECT sqlc.embed(t), sqlc.embed(u)
FROM access_tokens t
JOIN users u ON u.id = t.user_id
WHERE t.token_hash = $1 AND t.expires_at > now() AND u.disabled_at IS NULL;

-- name: TouchAccessToken :exec
UPDATE access_tokens SET last_used_at = now(), last_used_ip = $2 WHERE id = $1;

-- name: CountUserAccessTokens :one
SELECT count(*)::int FROM access_tokens WHERE user_id = $1 AND expires_at > now();

-- name: LockUser :exec
-- Serializes changes to one user's tokens.
SELECT id FROM users WHERE id = $1 FOR UPDATE;
