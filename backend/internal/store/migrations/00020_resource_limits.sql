-- +goose Up
-- Resource limits: the instance's (instance_settings, key resource_limits)
-- and each organization's own project limit (at most the instance's).
-- Who created an organization counts toward the per-person limit; existing
-- organizations are credited to their first Owner.
ALTER TABLE organizations
    ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN max_projects integer CHECK (max_projects > 0);

UPDATE organizations o SET created_by = (
    SELECT m.user_id FROM org_members m
    WHERE m.organization_id = o.id AND m.role = 'owner'
    ORDER BY m.created_at, m.user_id
    LIMIT 1
);

CREATE INDEX organizations_created_by ON organizations (created_by);

-- +goose Down
ALTER TABLE organizations DROP COLUMN max_projects, DROP COLUMN created_by;
