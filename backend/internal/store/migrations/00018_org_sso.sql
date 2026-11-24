-- +goose Up
-- Per-organization single sign-on: which of the instance's providers the
-- organization uses, whether members must sign in through it, and whether
-- people signing in through it join automatically.
ALTER TABLE organizations
    ADD COLUMN sso_provider     text,
    ADD COLUMN sso_required     boolean NOT NULL DEFAULT false,
    ADD COLUMN sso_join_role    org_role CHECK (sso_join_role IS DISTINCT FROM 'owner'),
    ADD COLUMN sso_join_domains text[] NOT NULL DEFAULT '{}';

-- How each session started ('' for a password), and so each access token
-- (from the session that made it): what an organization requiring SSO checks.
ALTER TABLE sessions ADD COLUMN sso_provider text NOT NULL DEFAULT '';
ALTER TABLE access_tokens ADD COLUMN sso_provider text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE access_tokens DROP COLUMN sso_provider;
ALTER TABLE sessions DROP COLUMN sso_provider;
ALTER TABLE organizations DROP COLUMN sso_join_domains, DROP COLUMN sso_join_role, DROP COLUMN sso_required,
    DROP COLUMN sso_provider;
