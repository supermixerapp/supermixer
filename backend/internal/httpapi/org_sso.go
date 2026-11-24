package httpapi

import (
	"context"
	"regexp"
	"slices"
	"strings"

	"supermixer/internal/api"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Per-organization single sign-on (Organization Settings › SSO): which of
// the instance's providers ([[sso.providers]]) the organization uses,
// whether members must sign in through it (ssoGate), and whether people
// signing in through it join by themselves (ssoAutoJoin).

var domainPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

func (h *handlers) toOrganizationSso(o db.Organization, p *principal) api.OrganizationSso {
	out := api.OrganizationSso{Provider: o.SsoProvider, Required: o.SsoRequired, JoinDomains: o.SsoJoinDomains}
	if out.JoinDomains == nil {
		out.JoinDomains = []string{}
	}
	if o.SsoJoinRole.Valid {
		r := api.OrgRole(o.SsoJoinRole.OrgRole)
		out.JoinRole = &r
	}
	if o.SsoProvider != nil && h.sso[*o.SsoProvider] == nil {
		out.ProviderMissing = ptr(true)
	}
	for _, sp := range h.ssoList() {
		out.Providers = append(out.Providers, struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}{sp.Id, sp.Name})
	}
	if out.Providers == nil {
		out.Providers = []struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}{}
	}
	if s := p.signedInWith(); s != "" {
		out.SignedInWith = &s
	}
	return out
}

func (h *handlers) GetOrganizationSso(ctx context.Context, req api.GetOrganizationSsoRequestObject) (api.GetOrganizationSsoResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgUpdate, "change single sign-on settings")
	if err != nil {
		return nil, err
	}
	return api.GetOrganizationSso200JSONResponse(h.toOrganizationSso(a.Org, a.User)), nil
}

func (h *handlers) UpdateOrganizationSso(ctx context.Context, req api.UpdateOrganizationSsoRequestObject) (api.UpdateOrganizationSsoResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgUpdate, "change single sign-on settings")
	if err != nil {
		return nil, err
	}
	b := req.Body
	params := db.SetOrganizationSSOParams{ID: a.Org.ID, SsoJoinDomains: []string{}}
	if b.Provider != nil && *b.Provider != "" {
		sp := h.sso[*b.Provider]
		if sp == nil {
			return nil, badRequest("%q isn't one of this instance's sign-in providers (sso.providers)", *b.Provider)
		}
		params.SsoProvider = b.Provider
		if b.Required {
			// Requiring it without having signed in with it would lock the
			// requester out.
			if a.User.signedInWith() != sp.cfg.ID {
				return nil, badRequest("sign in with %s before requiring it, so you can still reach the organization", sp.cfg.Name)
			}
			params.SsoRequired = true
		}
		if b.JoinRole != nil {
			role := rbac.Role(*b.JoinRole)
			if role == rbac.Owner || !slices.Contains(rbac.OrgRoles, role) {
				return nil, badRequest("people can join by themselves as an administrator, developer, read-only or no-access member, not an owner")
			}
			params.SsoJoinRole = db.NullOrgRole{OrgRole: db.OrgRole(role), Valid: true}
			for _, d := range b.JoinDomains {
				d = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(d), "@"))
				if d == "" {
					continue
				}
				if !domainPattern.MatchString(d) {
					return nil, badRequest("%q isn't an email domain like example.com", d)
				}
				if !slices.Contains(params.SsoJoinDomains, d) {
					params.SsoJoinDomains = append(params.SsoJoinDomains, d)
				}
			}
		}
	} else if b.Required || b.JoinRole != nil {
		return nil, badRequest("choose a sign-in provider first")
	}
	org, err := h.deps.Store.Queries.SetOrganizationSSO(ctx, params)
	if err != nil {
		return nil, err
	}
	meta := map[string]any{"provider": org.SsoProvider, "required": org.SsoRequired, "join_domains": org.SsoJoinDomains}
	if org.SsoJoinRole.Valid {
		meta["join_role"] = org.SsoJoinRole.OrgRole
	}
	h.audit(ctx, nil, auditEntry{OrgID: &org.ID, Action: "organization.sso_updated", TargetType: "organization",
		TargetID: org.ID.String(), TargetName: org.Name, Metadata: meta})
	return api.UpdateOrganizationSso200JSONResponse(h.toOrganizationSso(org, a.User)), nil
}

// ssoAutoJoin adds someone who just signed in through a provider to the
// organizations that let its people join, when their email (as the
// provider vouched for it) is in the organization's domains, or always if
// it lists none.
func (h *handlers) ssoAutoJoin(ctx context.Context, u db.User, provider, email string) {
	q := h.deps.Store.Queries
	orgs, err := q.ListSSOJoinOrganizations(ctx, &provider)
	if err != nil {
		h.deps.Logger.ErrorContext(ctx, "single sign-on: listing organizations to join", "err", err)
		return
	}
	for _, o := range orgs {
		if len(o.SsoJoinDomains) > 0 && !emailInDomains(email, o.SsoJoinDomains) {
			continue
		}
		n, err := q.AddMember(ctx, db.AddMemberParams{OrganizationID: o.ID, UserID: u.ID, Role: o.SsoJoinRole.OrgRole})
		if err != nil {
			h.deps.Logger.ErrorContext(ctx, "single sign-on: joining an organization", "org", o.Slug, "err", err)
			continue
		}
		if n == 0 {
			continue // already a member: their role stays
		}
		h.audit(ctx, nil, auditEntry{OrgID: &o.ID, Action: "member.joined", TargetType: "user", TargetID: u.ID.String(),
			TargetName: u.Username, Metadata: map[string]any{"role": o.SsoJoinRole.OrgRole, "via": "sso", "sso": provider}})
	}
}
