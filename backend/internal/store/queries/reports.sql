-- Instance › Organizations and Instance › Projects: how the instance is
-- used, for instance admins' reports. Metadata only: no settings, keys or
-- connection details, and nothing from inside a project.

-- name: ReportOrganizations :many
SELECT o.id, o.slug, o.name, o.created_at, o.mfa_required, o.sso_provider, o.sso_required, o.max_projects,
       u.username AS created_by_username,
       (SELECT count(*) FROM org_members m WHERE m.organization_id = o.id)::int AS members,
       (SELECT count(*) FROM projects p WHERE p.organization_id = o.id)::int AS projects,
       (SELECT count(*) FROM projects p WHERE p.organization_id = o.id AND p.managed)::int AS managed_projects
FROM organizations o
LEFT JOIN users u ON u.id = o.created_by
ORDER BY o.name, o.slug;

-- name: ReportOrganizationOwners :many
-- Owners who can still sign in: an organization whose owners are all
-- disabled shows none.
SELECT m.organization_id, u.username
FROM org_members m JOIN users u ON u.id = m.user_id
WHERE m.role = 'owner' AND u.disabled_at IS NULL
ORDER BY u.username;

-- name: ReportOrganizationActivity :many
-- When anything last happened in each organization, by its audit log (one
-- index lookup each); organizations with no entries are left out.
SELECT o.id AS organization_id, a.created_at AS last_activity_at
FROM organizations o
CROSS JOIN LATERAL (
    SELECT created_at FROM audit_logs WHERE organization_id = o.id ORDER BY id DESC LIMIT 1
) a;

-- name: ReportProjects :many
SELECT p.id, p.ref, p.name, p.managed, p.stack_status, p.stack_template, p.created_at,
       o.slug AS organization_slug, o.name AS organization_name,
       u.username AS created_by_username
FROM projects p
JOIN organizations o ON o.id = p.organization_id
LEFT JOIN users u ON u.id = p.created_by
ORDER BY o.name, p.name;

-- name: ReportLatestBackups :many
-- Each project's newest backup, whatever became of it.
SELECT DISTINCT ON (project_id) project_id, status, started_at
FROM backups
ORDER BY project_id, started_at DESC;

-- name: ReportBackupTotals :many
-- Each project's completed backups: how many, their size together, and when
-- the newest started.
SELECT project_id, count(*)::int AS backups, coalesce(sum(size_bytes), 0)::bigint AS size_bytes,
       max(started_at)::timestamptz AS last_completed_at
FROM backups
WHERE status = 'completed'
GROUP BY project_id;
