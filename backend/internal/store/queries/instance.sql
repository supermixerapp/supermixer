-- name: GetInstalledAt :one
SELECT (value #>> '{}')::timestamptz AS installed_at
FROM instance_settings
WHERE key = 'installed_at';
