-- name: GetInstalledAt :one
SELECT (value #>> '{}')::timestamptz AS installed_at
FROM instance_settings
WHERE key = 'installed_at';

-- name: GetInstanceSetting :one
SELECT value, updated_at FROM instance_settings WHERE key = $1;

-- name: SetInstanceSetting :exec
INSERT INTO instance_settings (key, value, updated_at) VALUES ($1, $2, now())
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();

-- name: DeleteInstanceSetting :execrows
DELETE FROM instance_settings WHERE key = $1;
