package httpapi

import (
	"context"
	"time"

	"github.com/google/uuid"

	"supermixer/internal/api"
	"supermixer/internal/store/db"
)

// Instance › Organizations and Instance › Projects: every organization and
// project on the instance, for instance admins' reports on how it's used.
// Metadata only, and no access: an instance admin still sees an
// organization's own pages, and a project's, only as a member.

func (h *handlers) ListInstanceOrganizations(ctx context.Context, _ api.ListInstanceOrganizationsRequestObject) (api.ListInstanceOrganizationsResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	rows, err := q.ReportOrganizations(ctx)
	if err != nil {
		return nil, err
	}
	ownerRows, err := q.ReportOrganizationOwners(ctx)
	if err != nil {
		return nil, err
	}
	owners := map[uuid.UUID][]string{}
	for _, r := range ownerRows {
		owners[r.OrganizationID] = append(owners[r.OrganizationID], r.Username)
	}
	activityRows, err := q.ReportOrganizationActivity(ctx)
	if err != nil {
		return nil, err
	}
	activity := map[uuid.UUID]time.Time{}
	for _, r := range activityRows {
		activity[r.OrganizationID] = r.LastActivityAt
	}
	limits, err := readInstanceLimits(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make(api.ListInstanceOrganizations200JSONResponse, 0, len(rows))
	for _, o := range rows {
		org := api.InstanceOrganization{
			Id: o.ID, Slug: o.Slug, Name: o.Name, CreatedAt: o.CreatedAt, CreatedBy: o.CreatedByUsername,
			Owners: owners[o.ID], Members: int(o.Members), Projects: int(o.Projects), ManagedProjects: int(o.ManagedProjects),
			ProjectLimit: projectLimit(limits, o.MaxProjects), MfaRequired: o.MfaRequired, SsoRequired: o.SsoRequired,
		}
		if org.Owners == nil {
			org.Owners = []string{}
		}
		if o.SsoProvider != nil {
			name := *o.SsoProvider
			if p := h.sso[name]; p == nil {
				// Removed from the config: ssoGate no longer enforces it.
				org.SsoProviderMissing = true
			} else if p.cfg.Name != "" {
				name = p.cfg.Name
			}
			org.SsoProvider = &name
		}
		if at, ok := activity[o.ID]; ok {
			org.LastActivityAt = &at
		}
		out = append(out, org)
	}
	return out, nil
}

func (h *handlers) ListInstanceProjects(ctx context.Context, _ api.ListInstanceProjectsRequestObject) (api.ListInstanceProjectsResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	rows, err := q.ReportProjects(ctx)
	if err != nil {
		return nil, err
	}
	latestRows, err := q.ReportLatestBackups(ctx)
	if err != nil {
		return nil, err
	}
	latest := map[uuid.UUID]db.ReportLatestBackupsRow{}
	for _, b := range latestRows {
		latest[b.ProjectID] = b
	}
	totalRows, err := q.ReportBackupTotals(ctx)
	if err != nil {
		return nil, err
	}
	totals := map[uuid.UUID]db.ReportBackupTotalsRow{}
	for _, t := range totalRows {
		totals[t.ProjectID] = t
	}
	out := make(api.ListInstanceProjects200JSONResponse, 0, len(rows))
	for _, p := range rows {
		ip := api.InstanceProject{
			Id: p.ID, Ref: p.Ref, Name: p.Name, OrganizationSlug: p.OrganizationSlug, OrganizationName: p.OrganizationName,
			CreatedBy: p.CreatedByUsername, CreatedAt: p.CreatedAt, Managed: p.Managed,
		}
		if p.Managed && p.StackStatus.Valid {
			s := api.StackStatus(p.StackStatus.StackStatus)
			ip.Status, ip.Operation = &s, h.stacks.current(p.Ref)
			if p.StackTemplate != "" {
				t := p.StackTemplate
				ip.Template = &t
			}
		}
		if b, ok := latest[p.ID]; ok {
			ip.LastBackup = &struct {
				StartedAt time.Time                           `json:"started_at"`
				Status    api.InstanceProjectLastBackupStatus `json:"status"`
			}{b.StartedAt, api.InstanceProjectLastBackupStatus(b.Status)}
		}
		if t, ok := totals[p.ID]; ok {
			ip.Backups, ip.BackupBytes, ip.LastCompletedBackupAt = int(t.Backups), t.SizeBytes, &t.LastCompletedAt
		}
		out = append(out, ip)
	}
	return out, nil
}
