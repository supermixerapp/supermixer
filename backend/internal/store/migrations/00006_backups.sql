-- +goose Up
-- Database backups of stacks Supermixer created: Supabase-style
-- dumps in provisioning.backups_dir/<ref>/<id>/.
CREATE TYPE backup_kind AS ENUM ('scheduled', 'manual', 'pre_restore');
CREATE TYPE backup_status AS ENUM ('running', 'completed', 'failed');

CREATE TABLE backups (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- A project's backups go with it (as on Supabase).
    project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind             backup_kind NOT NULL,
    status           backup_status NOT NULL DEFAULT 'running',
    error            text NOT NULL DEFAULT '',
    size_bytes       bigint NOT NULL DEFAULT 0,
    -- The supabase/supabase template and Postgres version it was taken from.
    template         text NOT NULL,
    postgres_version text NOT NULL DEFAULT '',
    created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    started_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz
);
CREATE INDEX backups_project_started ON backups (project_id, started_at DESC);

-- +goose Down
DROP TABLE backups;
DROP TYPE backup_status;
DROP TYPE backup_kind;
