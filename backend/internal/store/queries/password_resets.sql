-- name: CreatePasswordReset :one
INSERT INTO password_resets (user_id, token_hash, ip, expires_at) VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: DeletePasswordResets :exec
-- A new link, or a changed password, ends the earlier links.
DELETE FROM password_resets WHERE user_id = $1;

-- name: GetPasswordReset :one
SELECT * FROM password_resets
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now();

-- name: UsePasswordReset :one
UPDATE password_resets SET used_at = now()
WHERE id = $1 AND used_at IS NULL AND expires_at > now()
RETURNING id;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE lower(email) = lower($1);
