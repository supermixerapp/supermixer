-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: CreateUser :one
INSERT INTO users (username, email, display_name, password_hash, is_instance_admin, default_password, password_change_required)
VALUES ($1, $2, $3, $4, $5, $6, $7)
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
UPDATE users SET password_hash = $2, default_password = $3, password_change_required = $4, has_password = true, updated_at = now() WHERE id = $1;

-- name: SetPasswordChangeRequired :one
UPDATE users SET password_change_required = $2, updated_at = now() WHERE id = $1
RETURNING *;

-- name: InstanceCounts :one
SELECT (SELECT count(*) FROM users)::int AS users,
       (SELECT count(*) FROM users WHERE disabled_at IS NULL)::int AS active_users,
       (SELECT count(*) FROM users WHERE is_instance_admin AND disabled_at IS NULL)::int AS instance_admins,
       (SELECT count(*) FROM users WHERE password_change_required AND disabled_at IS NULL)::int AS password_change_required,
       (SELECT count(*) FROM users WHERE mfa_enabled_at IS NOT NULL AND disabled_at IS NULL)::int AS mfa_enabled,
       (SELECT count(*) FROM organizations)::int AS organizations,
       (SELECT count(*) FROM projects)::int AS projects,
       (SELECT count(*) FROM projects WHERE managed)::int AS managed_projects;

-- name: UserLastSeen :many
-- When each user was last active, from their sessions.
SELECT user_id, max(last_seen_at)::timestamptz AS last_seen_at, count(*)::int AS sessions
FROM sessions WHERE expires_at > now() GROUP BY user_id;

-- name: CountActiveInstanceAdmins :one
SELECT count(*) FROM users WHERE is_instance_admin AND disabled_at IS NULL;

-- name: ListDefaultPasswordUsers :many
SELECT username FROM users WHERE default_password AND disabled_at IS NULL;

-- name: SetUserTheme :one
UPDATE users SET theme = $2, updated_at = now() WHERE id = $1
RETURNING *;

-- name: RehashUserPassword :exec
-- The same password, hashed again (normalized); only if it hasn't changed since.
UPDATE users SET password_hash = @new_hash WHERE id = @id AND password_hash = @old_hash;
