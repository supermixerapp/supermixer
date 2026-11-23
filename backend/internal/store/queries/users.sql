-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: CreateUser :one
INSERT INTO users (username, email, display_name, password_hash, is_instance_admin, default_password)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByUsername :one
SELECT * FROM users WHERE username = $1;

-- name: ListUsers :many
SELECT * FROM users ORDER BY username;

-- name: UpdateUser :one
UPDATE users
SET display_name = $2, email = $3, is_instance_admin = $4, disabled_at = $5, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: SetUserPassword :exec
UPDATE users SET password_hash = $2, default_password = $3, updated_at = now() WHERE id = $1;

-- name: CountActiveInstanceAdmins :one
SELECT count(*) FROM users WHERE is_instance_admin AND disabled_at IS NULL;

-- name: ListDefaultPasswordUsers :many
SELECT username FROM users WHERE default_password AND disabled_at IS NULL;
