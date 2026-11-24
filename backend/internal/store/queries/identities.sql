-- name: GetIdentity :one
SELECT * FROM user_identities WHERE provider = $1 AND subject = $2;

-- name: AddIdentity :one
INSERT INTO user_identities (user_id, provider, subject, email, last_sign_in_at) VALUES ($1, $2, $3, $4, now())
RETURNING *;

-- name: TouchIdentity :exec
-- Keeps the last address the provider vouched for.
UPDATE user_identities SET last_sign_in_at = now(), email = COALESCE(NULLIF(@email::text, ''), email) WHERE id = @id;

-- name: ListUserIdentities :many
SELECT * FROM user_identities WHERE user_id = $1 ORDER BY created_at;

-- name: ListAllIdentities :many
SELECT user_id, provider FROM user_identities ORDER BY provider;

-- name: DeleteIdentity :one
DELETE FROM user_identities WHERE id = $1 AND user_id = $2 RETURNING *;

-- name: CreateSSOUser :one
INSERT INTO users (username, email, display_name, password_hash, has_password)
VALUES ($1, $2, $3, $4, false)
RETURNING *;

-- name: UsernameTaken :one
SELECT EXISTS (SELECT 1 FROM users WHERE username = $1);
