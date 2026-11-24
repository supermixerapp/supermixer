-- +goose Up
-- When each of a created stack's keys was last rotated (the rotation's
-- start), so advice to rotate clears once every key it asks for is new,
-- whether rotated together or one by one.
CREATE TABLE key_rotations (
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    key        text NOT NULL,
    started_at timestamptz NOT NULL,
    PRIMARY KEY (project_id, key)
);

-- +goose Down
DROP TABLE key_rotations;
