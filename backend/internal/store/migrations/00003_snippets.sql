-- +goose Up
CREATE TYPE snippet_visibility AS ENUM ('private', 'project');

-- Saved SQL Editor queries. Private ones are seen only by their owner;
-- project ones by everyone who can read the project's data.
CREATE TABLE sql_snippets (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    content    text NOT NULL DEFAULT '',
    visibility snippet_visibility NOT NULL DEFAULT 'private',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sql_snippets_project_idx ON sql_snippets (project_id, updated_at DESC);

CREATE TABLE sql_snippet_favorites (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    snippet_id uuid NOT NULL REFERENCES sql_snippets (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, snippet_id)
);

-- +goose Down
DROP TABLE sql_snippet_favorites;
DROP TABLE sql_snippets;
DROP TYPE snippet_visibility;
