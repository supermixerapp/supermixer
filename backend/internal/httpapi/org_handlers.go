package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/naming"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

const invitationTTL = 7 * 24 * time.Hour

func validOrgName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || len([]rune(s)) > 64 {
		return "", badRequest("organization name must be 1–64 characters")
	}
	return s, nil
}

func toOrganization(o db.Organization, role rbac.Role, projectCount int) api.Organization {
	return api.Organization{
		Id: o.ID, Slug: o.Slug, Name: o.Name, Role: api.OrgRole(role),
		Permissions: permStrings(rbac.OrgPermissions(role)), ProjectCount: projectCount, MfaRequired: o.MfaRequired,
		CreatedAt: o.CreatedAt,
	}
}

func (h *handlers) ListOrganizations(ctx context.Context, _ api.ListOrganizationsRequestObject) (api.ListOrganizationsResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	orgs, projects, err := h.visibleProjects(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	counts := map[uuid.UUID]int{}
	for _, vp := range projects {
		counts[vp.Row.Project.OrganizationID]++
	}
	out := make(api.ListOrganizations200JSONResponse, 0, len(orgs))
	for _, o := range orgs {
		out = append(out, toOrganization(o.Organization, rbac.Role(o.Role), counts[o.Organization.ID]))
	}
	return out, nil
}

func (h *handlers) CreateOrganization(ctx context.Context, req api.CreateOrganizationRequestObject) (api.CreateOrganizationResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	name, err := validOrgName(req.Body.Name)
	if err != nil {
		return nil, err
	}
	var org db.Organization
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		base := naming.Slugify(name)
		slug := base
		for i := 2; ; i++ {
			exists, err := q.OrganizationSlugExists(ctx, slug)
			if err != nil {
				return err
			}
			if !exists {
				break
			}
			slug = fmt.Sprintf("%s-%d", base, i)
		}
		if org, err = q.CreateOrganization(ctx, db.CreateOrganizationParams{Slug: slug, Name: name}); err != nil {
			return err
		}
		if _, err := q.AddMember(ctx, db.AddMemberParams{OrganizationID: org.ID, UserID: p.User.ID, Role: db.OrgRoleOwner}); err != nil {
			return err
		}
		h.audit(ctx, q, auditEntry{OrgID: &org.ID, Action: "organization.created", TargetType: "organization", TargetID: org.Slug, TargetName: org.Name})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return api.CreateOrganization201JSONResponse(toOrganization(org, rbac.Owner, 0)), nil
}

func (h *handlers) projectCount(ctx context.Context, a *orgAccess) (int, error) {
	_, projects, err := h.visibleProjects(ctx, a.User.User.ID)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, vp := range projects {
		if vp.Row.Project.OrganizationID == a.Org.ID {
			n++
		}
	}
	return n, nil
}

func (h *handlers) GetOrganization(ctx context.Context, req api.GetOrganizationRequestObject) (api.GetOrganizationResponseObject, error) {
	// Without required two-factor sign-in, members still see the name and
	// mfa_required, so the app can say what to do.
	a, err := h.loadOrgMFA(ctx, req.Slug, rbac.OrgRead, "view this organization", false)
	if err != nil {
		return nil, err
	}
	n, err := h.projectCount(ctx, a)
	if err != nil {
		return nil, err
	}
	return api.GetOrganization200JSONResponse(toOrganization(a.Org, a.Role, n)), nil
}

func (h *handlers) UpdateOrganization(ctx context.Context, req api.UpdateOrganizationRequestObject) (api.UpdateOrganizationResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgUpdate, "update organization settings")
	if err != nil {
		return nil, err
	}
	b := req.Body
	if b.Name == nil && b.MfaRequired == nil {
		return nil, badRequest("give name or mfa_required")
	}
	name, mfa := a.Org.Name, a.Org.MfaRequired
	if b.Name != nil {
		if name, err = validOrgName(*b.Name); err != nil {
			return nil, err
		}
	}
	if b.MfaRequired != nil {
		// Requiring it without having it would lock the requester out.
		if *b.MfaRequired && !a.Org.MfaRequired && !hasMFA(a.User.User) {
			return nil, badRequest("turn on two-factor sign-in for your own account (Account › Security) before requiring it")
		}
		mfa = *b.MfaRequired
	}
	org, err := h.deps.Store.Queries.UpdateOrganization(ctx, db.UpdateOrganizationParams{ID: a.Org.ID, Name: name, MfaRequired: mfa})
	if err != nil {
		return nil, err
	}
	meta := map[string]any{}
	if org.Name != a.Org.Name {
		meta["previous_name"] = a.Org.Name
	}
	if org.MfaRequired != a.Org.MfaRequired {
		meta["mfa_required"] = org.MfaRequired
	}
	h.audit(ctx, nil, auditEntry{OrgID: &org.ID, Action: "organization.updated", TargetType: "organization", TargetID: org.Slug, TargetName: org.Name,
		Metadata: meta})
	n, err := h.projectCount(ctx, a)
	if err != nil {
		return nil, err
	}
	return api.UpdateOrganization200JSONResponse(toOrganization(org, a.Role, n)), nil
}

func (h *handlers) DeleteOrganization(ctx context.Context, req api.DeleteOrganizationRequestObject) (api.DeleteOrganizationResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgDelete, "delete this organization")
	if err != nil {
		return nil, err
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		n, err := q.CountOrganizationProjects(ctx, a.Org.ID)
		if err != nil {
			return err
		}
		if n > 0 {
			return conflict("This organization still has %d project%s. Transfer or remove them first.", n, plural(int(n)))
		}
		h.audit(ctx, q, auditEntry{OrgID: &a.Org.ID, Action: "organization.deleted", TargetType: "organization", TargetID: a.Org.Slug, TargetName: a.Org.Name})
		return q.DeleteOrganization(ctx, a.Org.ID)
	})
	if err != nil {
		return nil, err
	}
	return api.DeleteOrganization204Response{}, nil
}

// ---------------------------------------------------------------- members

func (h *handlers) memberList(ctx context.Context, orgID uuid.UUID) ([]api.Member, error) {
	q := h.deps.Store.Queries
	rows, err := q.ListMembers(ctx, orgID)
	if err != nil {
		return nil, err
	}
	roles, err := q.ListOrganizationProjectRoles(ctx, orgID)
	if err != nil {
		return nil, err
	}
	byUser := map[uuid.UUID][]api.MemberProjectRole{}
	for _, r := range roles {
		byUser[r.UserID] = append(byUser[r.UserID], api.MemberProjectRole{Ref: r.Ref, Name: r.Name, Role: api.ProjectRole(r.Role)})
	}
	out := make([]api.Member, 0, len(rows))
	for _, r := range rows {
		pr := byUser[r.User.ID]
		if pr == nil {
			pr = []api.MemberProjectRole{}
		}
		out = append(out, api.Member{
			UserId: r.User.ID, Username: r.User.Username, DisplayName: r.User.DisplayName, Email: r.User.Email,
			Role: api.OrgRole(r.Role), ProjectRoles: pr, MfaEnabled: hasMFA(r.User), JoinedAt: r.JoinedAt,
		})
	}
	return out, nil
}

func (h *handlers) ListMembers(ctx context.Context, req api.ListMembersRequestObject) (api.ListMembersResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.MembersRead, "view the team")
	if err != nil {
		return nil, err
	}
	members, err := h.memberList(ctx, a.Org.ID)
	if err != nil {
		return nil, err
	}
	return api.ListMembers200JSONResponse(members), nil
}

// resolveProjectRoles checks each assignment names a project in org.
func resolveProjectRoles(ctx context.Context, q *db.Queries, orgID uuid.UUID, in []api.ProjectRoleAssignment) (map[uuid.UUID]db.ProjectRole, error) {
	if len(in) == 0 {
		return nil, nil
	}
	projects, err := q.ListProjectsByOrganization(ctx, orgID)
	if err != nil {
		return nil, err
	}
	byRef := map[string]uuid.UUID{}
	for _, p := range projects {
		byRef[p.Ref] = p.ID
	}
	out := map[uuid.UUID]db.ProjectRole{}
	for _, a := range in {
		id, ok := byRef[a.Ref]
		if !ok {
			return nil, badRequest("project %q is not in this organization", a.Ref)
		}
		if !rbac.ValidProjectRole(rbac.Role(a.Role)) {
			return nil, badRequest("%q is not a project role", a.Role)
		}
		out[id] = db.ProjectRole(a.Role)
	}
	return out, nil
}

// ensureOwnerRemains fails if removing or demoting target would leave no Owner.
func ensureOwnerRemains(ctx context.Context, q *db.Queries, orgID uuid.UUID, targetRole rbac.Role) error {
	if targetRole != rbac.Owner {
		return nil
	}
	n, err := q.CountOwners(ctx, orgID)
	if err != nil {
		return err
	}
	if n <= 1 {
		return conflict("An organization needs at least one Owner. Make someone else an Owner first.")
	}
	return nil
}

func (h *handlers) UpdateMember(ctx context.Context, req api.UpdateMemberRequestObject) (api.UpdateMemberResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.MembersUpdate, "change member roles")
	if err != nil {
		return nil, err
	}
	newRole := rbac.Role(req.Body.Role)
	if !rbac.ValidOrgRole(newRole) {
		return nil, badRequest("%q is not an organization role", req.Body.Role)
	}
	var target db.User
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		cur, err := q.GetMemberRole(ctx, db.GetMemberRoleParams{OrganizationID: a.Org.ID, UserID: req.UserId})
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("member")
		} else if err != nil {
			return err
		}
		curRole := rbac.Role(cur)
		if !rbac.CanAssign(a.Role, curRole) || !rbac.CanAssign(a.Role, newRole) {
			return forbidden("manage Owners")
		}
		before, err := keyAccess(ctx, q, a.Org.ID, req.UserId)
		if err != nil {
			return err
		}
		if curRole != newRole {
			if err := ensureOwnerRemains(ctx, q, a.Org.ID, curRole); err != nil {
				return err
			}
			if err := q.UpdateMemberRole(ctx, db.UpdateMemberRoleParams{OrganizationID: a.Org.ID, UserID: req.UserId, Role: db.OrgRole(newRole)}); err != nil {
				return err
			}
		}
		meta := map[string]any{"previous_role": curRole, "role": newRole}
		if req.Body.ProjectRoles != nil {
			roles, err := resolveProjectRoles(ctx, q, a.Org.ID, *req.Body.ProjectRoles)
			if err != nil {
				return err
			}
			if err := q.DeleteMemberProjectRoles(ctx, db.DeleteMemberProjectRolesParams{OrganizationID: a.Org.ID, UserID: req.UserId}); err != nil {
				return err
			}
			for pid, role := range roles {
				if err := q.SetProjectRole(ctx, db.SetProjectRoleParams{ProjectID: pid, UserID: req.UserId, Role: role}); err != nil {
					return err
				}
			}
			meta["project_roles"] = *req.Body.ProjectRoles
		}
		if target, err = q.GetUserByID(ctx, req.UserId); err != nil {
			return err
		}
		after, err := keyAccess(ctx, q, a.Org.ID, req.UserId)
		if err != nil {
			return err
		}
		if target.DisabledAt == nil { // a disabled account was advised for when it was disabled
			if err := adviseRotation(ctx, q, before, after, target.Username, "role_changed"); err != nil {
				return err
			}
		}
		h.audit(ctx, q, auditEntry{OrgID: &a.Org.ID, Action: "member.updated", TargetType: "user", TargetID: target.ID.String(), TargetName: target.Username, Metadata: meta})
		return nil
	})
	if err != nil {
		return nil, err
	}
	members, err := h.memberList(ctx, a.Org.ID)
	if err != nil {
		return nil, err
	}
	for _, m := range members {
		if m.UserId == req.UserId {
			return api.UpdateMember200JSONResponse(m), nil
		}
	}
	return nil, notFound("member")
}

func (h *handlers) RemoveMember(ctx context.Context, req api.RemoveMemberRequestObject) (api.RemoveMemberResponseObject, error) {
	// Anyone can leave, also without the two-factor sign-in the
	// organization requires; removing someone else needs it.
	me, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	self := req.UserId == me.User.ID
	a, err := h.loadOrgMFA(ctx, req.Slug, rbac.OrgRead, "", !self)
	if err != nil {
		return nil, err
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		cur, err := q.GetMemberRole(ctx, db.GetMemberRoleParams{OrganizationID: a.Org.ID, UserID: req.UserId})
		if errors.Is(err, pgx.ErrNoRows) {
			return notFound("member")
		} else if err != nil {
			return err
		}
		curRole := rbac.Role(cur)
		if !self {
			if !rbac.OrgCan(a.Role, rbac.MembersRemove) {
				return forbidden("remove members")
			}
			if !rbac.CanAssign(a.Role, curRole) {
				return forbidden("remove Owners")
			}
		}
		if err := ensureOwnerRemains(ctx, q, a.Org.ID, curRole); err != nil {
			return err
		}
		before, err := keyAccess(ctx, q, a.Org.ID, req.UserId)
		if err != nil {
			return err
		}
		if err := q.DeleteMemberProjectRoles(ctx, db.DeleteMemberProjectRolesParams{OrganizationID: a.Org.ID, UserID: req.UserId}); err != nil {
			return err
		}
		if err := q.RemoveMember(ctx, db.RemoveMemberParams{OrganizationID: a.Org.ID, UserID: req.UserId}); err != nil {
			return err
		}
		target, err := q.GetUserByID(ctx, req.UserId)
		if err != nil {
			return err
		}
		action, reason := "member.removed", "removed"
		if self {
			action, reason = "member.left", "left"
		}
		if target.DisabledAt == nil { // a disabled account was advised for when it was disabled
			if err := adviseRotation(ctx, q, before, nil, target.Username, reason); err != nil {
				return err
			}
		}
		h.audit(ctx, q, auditEntry{OrgID: &a.Org.ID, Action: action, TargetType: "user", TargetID: target.ID.String(), TargetName: target.Username,
			Metadata: map[string]any{"role": curRole}})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return api.RemoveMember204Response{}, nil
}

// ------------------------------------------------------------ invitations

// storedProjectRole is the JSON kept in invitations.project_roles.
type storedProjectRole struct {
	ProjectID uuid.UUID      `json:"project_id"`
	Role      db.ProjectRole `json:"role"`
}

func (h *handlers) invitationProjectRoles(ctx context.Context, orgID uuid.UUID, raw []byte) ([]api.MemberProjectRole, error) {
	var stored []storedProjectRole
	if err := json.Unmarshal(raw, &stored); err != nil || len(stored) == 0 {
		return []api.MemberProjectRole{}, nil
	}
	projects, err := h.deps.Store.Queries.ListProjectsByOrganization(ctx, orgID)
	if err != nil {
		return nil, err
	}
	byID := map[uuid.UUID]db.Project{}
	for _, p := range projects {
		byID[p.ID] = p
	}
	out := []api.MemberProjectRole{}
	for _, s := range stored {
		if p, ok := byID[s.ProjectID]; ok {
			out = append(out, api.MemberProjectRole{Ref: p.Ref, Name: p.Name, Role: api.ProjectRole(s.Role)})
		}
	}
	return out, nil
}

func (h *handlers) toInvitation(ctx context.Context, i db.Invitation, invitedBy string) (api.Invitation, error) {
	pr, err := h.invitationProjectRoles(ctx, i.OrganizationID, i.ProjectRoles)
	if err != nil {
		return api.Invitation{}, err
	}
	return api.Invitation{
		Id: i.ID, Email: i.Email, Role: api.OrgRole(i.Role), ProjectRoles: pr,
		InvitedBy: invitedBy, CreatedAt: i.CreatedAt, ExpiresAt: i.ExpiresAt,
	}, nil
}

func (h *handlers) ListInvitations(ctx context.Context, req api.ListInvitationsRequestObject) (api.ListInvitationsResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.MembersInvite, "view invitations")
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListPendingInvitations(ctx, a.Org.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListInvitations200JSONResponse, 0, len(rows))
	for _, r := range rows {
		inv, err := h.toInvitation(ctx, r.Invitation, r.InvitedByUsername)
		if err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, nil
}

func (h *handlers) CreateInvitation(ctx context.Context, req api.CreateInvitationRequestObject) (api.CreateInvitationResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.MembersInvite, "invite members")
	if err != nil {
		return nil, err
	}
	role := rbac.Role(req.Body.Role)
	if !rbac.ValidOrgRole(role) {
		return nil, badRequest("%q is not an organization role", req.Body.Role)
	}
	if !rbac.CanAssign(a.Role, role) {
		return nil, forbidden("invite Owners")
	}
	email := ""
	if req.Body.Email != nil {
		e, err := normalizeEmail(req.Body.Email)
		if err != nil {
			return nil, err
		}
		email = deref(e)
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		return nil, err
	}
	var inv db.Invitation
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		roles, err := resolveProjectRoles(ctx, q, a.Org.ID, deref(req.Body.ProjectRoles))
		if err != nil {
			return err
		}
		stored := []storedProjectRole{}
		for pid, r := range roles {
			stored = append(stored, storedProjectRole{ProjectID: pid, Role: r})
		}
		raw, _ := json.Marshal(stored)
		inv, err = q.CreateInvitation(ctx, db.CreateInvitationParams{
			OrganizationID: a.Org.ID, TokenHash: hash, Email: email, Role: db.OrgRole(role),
			ProjectRoles: raw, InvitedBy: &a.User.User.ID, ExpiresAt: time.Now().Add(invitationTTL),
		})
		if err != nil {
			return err
		}
		h.audit(ctx, q, auditEntry{OrgID: &a.Org.ID, Action: "invitation.created", TargetType: "invitation", TargetID: inv.ID.String(), TargetName: email,
			Metadata: map[string]any{"role": role}})
		return nil
	})
	if err != nil {
		return nil, err
	}
	base, err := h.toInvitation(ctx, inv, a.User.User.Username)
	if err != nil {
		return nil, err
	}
	return api.CreateInvitation201JSONResponse{
		Id: base.Id, Email: base.Email, Role: base.Role, ProjectRoles: base.ProjectRoles, InvitedBy: base.InvitedBy,
		CreatedAt: base.CreatedAt, ExpiresAt: base.ExpiresAt,
		Token: token, Url: h.joinURL("/join", url.Values{"token": {token}}),
	}, nil
}

func (h *handlers) RevokeInvitation(ctx context.Context, req api.RevokeInvitationRequestObject) (api.RevokeInvitationResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.MembersInvite, "revoke invitations")
	if err != nil {
		return nil, err
	}
	n, err := h.deps.Store.Queries.DeleteInvitation(ctx, db.DeleteInvitationParams{ID: req.InvitationId, OrganizationID: a.Org.ID})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, notFound("invitation")
	}
	h.audit(ctx, nil, auditEntry{OrgID: &a.Org.ID, Action: "invitation.revoked", TargetType: "invitation", TargetID: req.InvitationId.String()})
	return api.RevokeInvitation204Response{}, nil
}

func (h *handlers) findInvitation(ctx context.Context, token string) (db.GetInvitationByTokenHashRow, error) {
	row, err := h.deps.Store.Queries.GetInvitationByTokenHash(ctx, auth.HashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return row, newError(http.StatusNotFound, "This invitation link is not valid")
	}
	return row, err
}

func invitationUsable(i db.Invitation) error {
	if i.AcceptedAt != nil {
		return newError(http.StatusGone, "This invitation has already been used")
	}
	if time.Now().After(i.ExpiresAt) {
		return newError(http.StatusGone, "This invitation has expired. Ask for a new one.")
	}
	return nil
}

func (h *handlers) GetInvitation(ctx context.Context, req api.GetInvitationRequestObject) (api.GetInvitationResponseObject, error) {
	row, err := h.findInvitation(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	i := row.Invitation
	return api.GetInvitation200JSONResponse{
		OrganizationName: row.OrganizationName, OrganizationSlug: row.OrganizationSlug, Role: api.OrgRole(i.Role),
		Email: i.Email, InvitedBy: row.InvitedByUsername, ExpiresAt: i.ExpiresAt, Valid: invitationUsable(i) == nil,
	}, nil
}

// joinOrganization consumes an invitation for userID inside a transaction.
func (h *handlers) joinOrganization(ctx context.Context, q *db.Queries, row db.GetInvitationByTokenHashRow, userID uuid.UUID, username string) error {
	inv := row.Invitation
	if err := invitationUsable(inv); err != nil {
		return err
	}
	if _, err := q.GetMemberRole(ctx, db.GetMemberRoleParams{OrganizationID: inv.OrganizationID, UserID: userID}); err == nil {
		return conflict("You are already a member of %s", row.OrganizationName)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if n, err := q.MarkInvitationAccepted(ctx, db.MarkInvitationAcceptedParams{ID: inv.ID, AcceptedBy: &userID}); err != nil {
		return err
	} else if n == 0 {
		return newError(http.StatusGone, "This invitation has already been used")
	}
	if _, err := q.AddMember(ctx, db.AddMemberParams{OrganizationID: inv.OrganizationID, UserID: userID, Role: inv.Role}); err != nil {
		return err
	}
	var stored []storedProjectRole
	_ = json.Unmarshal(inv.ProjectRoles, &stored)
	projects, err := q.ListProjectsByOrganization(ctx, inv.OrganizationID)
	if err != nil {
		return err
	}
	inOrg := map[uuid.UUID]bool{}
	for _, p := range projects {
		inOrg[p.ID] = true
	}
	for _, s := range stored {
		if !inOrg[s.ProjectID] {
			continue // removed or transferred since the invitation was made
		}
		if err := q.SetProjectRole(ctx, db.SetProjectRoleParams{ProjectID: s.ProjectID, UserID: userID, Role: s.Role}); err != nil {
			return err
		}
	}
	h.audit(ctx, q, auditEntry{OrgID: &inv.OrganizationID, Action: "member.joined", TargetType: "user", TargetID: userID.String(), TargetName: username,
		Metadata: map[string]any{"role": inv.Role, "invitation_id": inv.ID}})
	return nil
}

func (h *handlers) AcceptInvitation(ctx context.Context, req api.AcceptInvitationRequestObject) (api.AcceptInvitationResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	row, err := h.findInvitation(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	if err := h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		return h.joinOrganization(ctx, q, row, p.User.ID, p.User.Username)
	}); err != nil {
		return nil, err
	}
	a, err := h.loadOrgMFA(ctx, row.OrganizationSlug, rbac.OrgRead, "", false)
	if err != nil {
		return nil, err
	}
	n, err := h.projectCount(ctx, a)
	if err != nil {
		return nil, err
	}
	return api.AcceptInvitation200JSONResponse(toOrganization(a.Org, a.Role, n)), nil
}

func (h *handlers) SignUpWithInvitation(ctx context.Context, req api.SignUpWithInvitationRequestObject) (api.SignUpWithInvitationResponseObject, error) {
	row, err := h.findInvitation(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	if err := invitationUsable(row.Invitation); err != nil {
		return nil, err
	}
	b := req.Body
	params, err := newUserParams(b.Username, b.Password, b.Email, deref(b.DisplayName))
	if err != nil {
		return nil, err
	}
	var user db.User
	var cookies []*http.Cookie
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if user, err = q.CreateUser(ctx, params); err != nil {
			return createUserErr(err)
		}
		reqInfo(ctx).Principal = &principal{User: user}
		if err := h.joinOrganization(ctx, q, row, user.ID, user.Username); err != nil {
			return err
		}
		cookies, err = h.startSession(ctx, q, user.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return invitationSignUpResponse{withCookies{status: http.StatusCreated, body: toProfile(user), cookies: cookies}}, nil
}
