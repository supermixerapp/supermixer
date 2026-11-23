-- name: ListSnippets :many
SELECT s.id, s.name, s.visibility, s.owner_id, u.username AS owner_username, s.created_at, s.updated_at,
       EXISTS (SELECT 1 FROM sql_snippet_favorites f WHERE f.snippet_id = s.id AND f.user_id = @user_id) AS favorite
FROM sql_snippets s
JOIN users u ON u.id = s.owner_id
WHERE s.project_id = @project_id AND (s.owner_id = @user_id OR s.visibility = 'project')
ORDER BY s.updated_at DESC;

-- name: GetSnippet :one
SELECT sqlc.embed(s), u.username AS owner_username,
       EXISTS (SELECT 1 FROM sql_snippet_favorites f WHERE f.snippet_id = s.id AND f.user_id = @user_id) AS favorite
FROM sql_snippets s
JOIN users u ON u.id = s.owner_id
WHERE s.id = @id AND s.project_id = @project_id AND (s.owner_id = @user_id OR s.visibility = 'project');

-- name: CreateSnippet :one
INSERT INTO sql_snippets (project_id, owner_id, name, content, visibility)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: UpdateSnippet :one
UPDATE sql_snippets SET name = $2, content = $3, visibility = $4, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteSnippet :exec
DELETE FROM sql_snippets WHERE id = $1;

-- name: SetSnippetFavorite :exec
INSERT INTO sql_snippet_favorites (user_id, snippet_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: UnsetSnippetFavorite :exec
DELETE FROM sql_snippet_favorites WHERE user_id = $1 AND snippet_id = $2;
