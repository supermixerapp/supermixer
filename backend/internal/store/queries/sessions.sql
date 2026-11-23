-- name: CreateSession :one
INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetActiveSession :one
-- The session for a token, if it is unexpired and its user is enabled.
SELECT sqlc.embed(s), sqlc.embed(u)
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL;

-- name: TouchSession :exec
UPDATE sessions SET last_seen_at = now() WHERE id = $1;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE id = $1;

-- name: DeleteUserSession :execrows
DELETE FROM sessions WHERE id = $1 AND user_id = $2;

-- name: DeleteUserSessions :exec
DELETE FROM sessions WHERE user_id = $1;

-- name: DeleteOtherUserSessions :exec
DELETE FROM sessions WHERE user_id = $1 AND id <> $2;

-- name: ListUserSessions :many
SELECT * FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC;

-- name: DeleteExpiredSessions :exec
DELETE FROM sessions WHERE expires_at <= now();
