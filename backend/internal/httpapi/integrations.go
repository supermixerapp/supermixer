package httpapi

import (
	"context"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
)

// GetOrganizationIntegrations summarizes what the organization is connected
// to, for Organization › Integrations: counts and on/off states, which any
// member may see. Each integration's settings stay behind its own page.
func (h *handlers) GetOrganizationIntegrations(ctx context.Context, req api.GetOrganizationIntegrationsRequestObject) (api.GetOrganizationIntegrationsResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgRead, "view this organization")
	if err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	out := api.OrganizationIntegrations{}

	hooks, err := q.ListWebhooks(ctx, a.Org.ID)
	if err != nil {
		return nil, err
	}
	for _, w := range hooks {
		c := &out.Webhooks
		if isChatKind(w.Kind) {
			c = &out.Chat
		}
		c.Total++
		if w.Enabled && w.FailingSince != nil {
			c.Failing++
		}
	}

	out.Sso.Required = a.Org.SsoRequired
	if a.Org.SsoProvider != nil {
		name := *a.Org.SsoProvider
		if p := h.sso[name]; p == nil {
			// Removed from the config: ssoGate no longer enforces it.
			out.Sso.ProviderMissing = true
		} else if p.cfg.Name != "" {
			name = p.cfg.Name
		}
		out.Sso.Provider = &name
	}

	// Only projects the member can see (some see chosen projects only).
	projects, err := q.ListProjectsByOrganization(ctx, a.Org.ID)
	if err != nil {
		return nil, err
	}
	projectRoles, err := h.userProjectRoles(ctx, a.User.User.ID)
	if err != nil {
		return nil, err
	}
	for _, p := range projects {
		if h.stackOf(p) == nil || !rbac.ProjectCan(rbac.EffectiveProjectRole(a.Role, projectRoles[p.ID]), rbac.ProjectRead) {
			continue
		}
		drains, err := provision.ReadDrains(h.stackLayout(p.Ref).Dir)
		if err != nil || len(drains) == 0 {
			continue // a stack whose folder is missing shows its problem on its own page
		}
		out.LogDrains.Total += len(drains)
		out.LogDrains.Projects++
	}

	out.BackupCopies.Enabled = h.s3 != nil
	return api.GetOrganizationIntegrations200JSONResponse(out), nil
}
