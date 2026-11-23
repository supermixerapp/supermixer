-- +goose Up
-- Stacks Supermixer created itself (Stage 4) rather than connected to.
CREATE TYPE stack_status AS ENUM ('provisioning', 'running', 'paused', 'failed', 'deleting');

ALTER TABLE projects
    ADD COLUMN managed           boolean NOT NULL DEFAULT false,
    ADD COLUMN stack_status      stack_status,
    -- What went wrong last, shown with a failed status.
    ADD COLUMN stack_error       text NOT NULL DEFAULT '',
    ADD COLUMN stack_status_at   timestamptz,
    -- The supabase/supabase commit the stack's template came from.
    ADD COLUMN stack_template    text NOT NULL DEFAULT '',
    ADD COLUMN stack_api_port    integer,
    ADD COLUMN stack_db_port     integer,
    ADD COLUMN stack_pooler_port integer,
    ADD CONSTRAINT projects_managed_stack CHECK (
        NOT managed OR (stack_status IS NOT NULL AND stack_api_port IS NOT NULL
                        AND stack_db_port IS NOT NULL AND stack_pooler_port IS NOT NULL));

-- No two stacks get the same host port.
CREATE UNIQUE INDEX projects_stack_api_port ON projects (stack_api_port) WHERE stack_api_port IS NOT NULL;
CREATE UNIQUE INDEX projects_stack_db_port ON projects (stack_db_port) WHERE stack_db_port IS NOT NULL;
CREATE UNIQUE INDEX projects_stack_pooler_port ON projects (stack_pooler_port) WHERE stack_pooler_port IS NOT NULL;

-- +goose Down
ALTER TABLE projects
    DROP CONSTRAINT projects_managed_stack,
    DROP COLUMN managed, DROP COLUMN stack_status, DROP COLUMN stack_error, DROP COLUMN stack_status_at,
    DROP COLUMN stack_template, DROP COLUMN stack_api_port, DROP COLUMN stack_db_port, DROP COLUMN stack_pooler_port;
DROP TYPE stack_status;
