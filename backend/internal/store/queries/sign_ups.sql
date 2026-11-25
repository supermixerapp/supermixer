-- name: CreateSignUp :one
INSERT INTO sign_ups (email, token_hash, ip, expires_at) VALUES ($1, $2, $3, $4) RETURNING *;

-- name: DeleteExpiredSignUps :exec
DELETE FROM sign_ups WHERE expires_at < now() OR used_at IS NOT NULL;

-- name: GetSignUp :one
-- A link that still works.
SELECT * FROM sign_ups WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now();

-- name: UseSignUp :one
UPDATE sign_ups SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id;

-- name: DeleteSignUpsForEmail :exec
DELETE FROM sign_ups WHERE email = $1;

-- name: ApproveUser :one
UPDATE users SET waiting_approval = false, updated_at = now() WHERE id = $1 AND waiting_approval RETURNING *;

-- name: DeleteWaitingUser :one
-- Declining a sign-up: only an account still waiting for approval, which
-- has never signed in, so nothing else is lost with it.
DELETE FROM users WHERE id = $1 AND waiting_approval RETURNING *;

-- name: ListInstanceAdminEmails :many
SELECT email::text FROM users WHERE is_instance_admin AND disabled_at IS NULL AND email IS NOT NULL ORDER BY username;
