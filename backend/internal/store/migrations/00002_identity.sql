-- +goose Up
-- Stage 1: users, sessions, organizations, membership, projects, audit log.

CREATE TYPE org_role AS ENUM ('owner', 'administrator', 'developer', 'read_only', 'no_access');
-- Roles a member can hold on a single project (Supabase's project-scoped roles).
CREATE TYPE project_role AS ENUM ('administrator', 'developer', 'read_only');

CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username          text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$'),
    email             text UNIQUE,
    display_name      text NOT NULL DEFAULT '',
    password_hash     text NOT NULL,
    is_instance_admin boolean NOT NULL DEFAULT false,
    -- True while the account still uses the well-known bootstrap password.
    default_password  boolean NOT NULL DEFAULT false,
    disabled_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    ip           text NOT NULL DEFAULT '',
    user_agent   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE organizations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role            org_role NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX org_members_user_id_idx ON org_members (user_id);

CREATE TABLE projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ref             text NOT NULL UNIQUE CHECK (ref ~ '^[a-z]{20}$'),
    organization_id uuid NOT NULL REFERENCES organizations (id),
    name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    api_url         text NOT NULL,
    studio_url      text NOT NULL DEFAULT '',
    db_host         text NOT NULL,
    db_port         integer NOT NULL CHECK (db_port BETWEEN 1 AND 65535),
    db_name         text NOT NULL,
    db_user         text NOT NULL,
    db_sslmode      text NOT NULL DEFAULT 'prefer',
    -- AES-256-GCM sealed JSON of keys and the database password; the
    -- project ref is the additional data, so blobs cannot be swapped.
    secrets         bytea NOT NULL,
    created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_organization_id_idx ON projects (organization_id);

-- Project-scoped roles. A member with org role no_access plus rows here can
-- see only these projects.
CREATE TABLE project_member_roles (
    project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       project_role NOT NULL,
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_member_roles_user_id_idx ON project_member_roles (user_id);

CREATE TABLE invitations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    token_hash      bytea NOT NULL UNIQUE,
    email           text NOT NULL DEFAULT '',
    role            org_role NOT NULL,
    -- Project-scoped roles granted on acceptance: [{"project_id": "...", "role": "developer"}]
    project_roles   jsonb NOT NULL DEFAULT '[]',
    invited_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    accepted_at     timestamptz,
    accepted_by     uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX invitations_organization_id_idx ON invitations (organization_id);

CREATE TABLE audit_logs (
    id              bigserial PRIMARY KEY,
    -- Kept when the organization is deleted so instance admins can still audit it.
    organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
    project_id      uuid REFERENCES projects (id) ON DELETE SET NULL,
    actor_id        uuid REFERENCES users (id) ON DELETE SET NULL,
    actor_username  text NOT NULL DEFAULT '',
    action          text NOT NULL,
    target_type     text NOT NULL DEFAULT '',
    target_id       text NOT NULL DEFAULT '',
    target_name     text NOT NULL DEFAULT '',
    metadata        jsonb NOT NULL DEFAULT '{}',
    ip              text NOT NULL DEFAULT '',
    user_agent      text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created_idx ON audit_logs (organization_id, id DESC);

-- +goose Down
DROP TABLE audit_logs;
DROP TABLE invitations;
DROP TABLE project_member_roles;
DROP TABLE projects;
DROP TABLE org_members;
DROP TABLE organizations;
DROP TABLE sessions;
DROP TABLE users;
DROP TYPE project_role;
DROP TYPE org_role;
