-- +goose Up
-- Someone who could read a project's keys (or deploy functions, which can)
-- lost that access: its admins are told to rotate the keys, until they do
-- or dismiss it.
CREATE TABLE rotation_advisories (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    username   text NOT NULL,
    -- removed, left, role_changed, disabled or transferred
    reason     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rotation_advisories_project ON rotation_advisories (project_id);

-- Fingerprints of a project database's objects that could keep an attacker
-- in (roles, SECURITY DEFINER functions, triggers, event triggers, cron
-- jobs), taken before function deploys and on demand, to compare later.
CREATE TABLE db_snapshots (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    taken_at   timestamptz NOT NULL DEFAULT now(),
    -- What prompted it: manual, or function_deploy (with the function's name in detail).
    reason     text NOT NULL,
    detail     text NOT NULL DEFAULT '',
    taken_by   text NOT NULL DEFAULT '',
    data       jsonb NOT NULL
);
CREATE INDEX db_snapshots_project_taken ON db_snapshots (project_id, taken_at DESC);

-- +goose Down
DROP TABLE db_snapshots;
DROP TABLE rotation_advisories;
