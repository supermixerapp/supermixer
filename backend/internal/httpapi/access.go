package httpapi

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// orgAccess is a member's view of an organization.
type orgAccess struct {
	Org  db.Organization
	Role rbac.Role
	User *principal
}

// loadOrg finds an organization the caller belongs to and checks perm.
// Non-members get 404, so organization names do not leak.
func (h *handlers) loadOrg(ctx context.Context, slug string, perm rbac.Permission, action string) (*orgAccess, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	org, err := q.GetOrganizationBySlug(ctx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("organization")
	} else if err != nil {
		return nil, err
	}
	role, err := q.GetMemberRole(ctx, db.GetMemberRoleParams{OrganizationID: org.ID, UserID: p.User.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("organization")
	} else if err != nil {
		return nil, err
	}
	a := &orgAccess{Org: org, Role: rbac.Role(role), User: p}
	if perm != "" && !rbac.OrgCan(a.Role, perm) {
		return nil, forbidden(action)
	}
	return a, nil
}

// projectAccess is a member's view of a project.
type projectAccess struct {
	Row     db.GetProjectByRefRow
	OrgRole rbac.Role
	Role    rbac.Role // effective role on this project
	User    *principal
}

func (a *projectAccess) Project() db.Project { return a.Row.Project }

// loadProject finds a project the caller can see and checks perm.
func (h *handlers) loadProject(ctx context.Context, ref string, perm rbac.Permission, action string) (*projectAccess, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	row, err := q.GetProjectByRef(ctx, ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("project")
	} else if err != nil {
		return nil, err
	}
	orgRole, err := q.GetMemberRole(ctx, db.GetMemberRoleParams{OrganizationID: row.Project.OrganizationID, UserID: p.User.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("project")
	} else if err != nil {
		return nil, err
	}
	projectRoles, err := h.userProjectRoles(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	eff := rbac.EffectiveProjectRole(rbac.Role(orgRole), projectRoles[row.Project.ID])
	if !rbac.ProjectCan(eff, rbac.ProjectRead) {
		return nil, notFound("project")
	}
	a := &projectAccess{Row: row, OrgRole: rbac.Role(orgRole), Role: eff, User: p}
	if perm != "" && !rbac.ProjectCan(eff, perm) {
		return nil, forbidden(action)
	}
	return a, nil
}

func (h *handlers) userProjectRoles(ctx context.Context, userID uuid.UUID) (map[uuid.UUID]*rbac.Role, error) {
	rows, err := h.deps.Store.Queries.ListUserProjectRoles(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]*rbac.Role, len(rows))
	for _, r := range rows {
		role := rbac.Role(r.Role)
		out[r.ProjectID] = &role
	}
	return out, nil
}

// visibleProject is a project with the caller's roles on it.
type visibleProject struct {
	Row     db.ListProjectsInOrganizationsRow
	OrgRole rbac.Role
	Role    rbac.Role
}

// visibleProjects lists every project the user may read, across organizations.
func (h *handlers) visibleProjects(ctx context.Context, userID uuid.UUID) ([]db.ListOrganizationsForUserRow, []visibleProject, error) {
	q := h.deps.Store.Queries
	orgs, err := q.ListOrganizationsForUser(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	orgRoles := make(map[uuid.UUID]rbac.Role, len(orgs))
	ids := make([]uuid.UUID, 0, len(orgs))
	for _, o := range orgs {
		orgRoles[o.Organization.ID] = rbac.Role(o.Role)
		ids = append(ids, o.Organization.ID)
	}
	rows, err := q.ListProjectsInOrganizations(ctx, ids)
	if err != nil {
		return nil, nil, err
	}
	projectRoles, err := h.userProjectRoles(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	var out []visibleProject
	for _, r := range rows {
		orgRole := orgRoles[r.Project.OrganizationID]
		eff := rbac.EffectiveProjectRole(orgRole, projectRoles[r.Project.ID])
		if rbac.ProjectCan(eff, rbac.ProjectRead) {
			out = append(out, visibleProject{Row: r, OrgRole: orgRole, Role: eff})
		}
	}
	return orgs, out, nil
}

func permStrings(ps []rbac.Permission) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = string(p)
	}
	return out
}

// auditEntry is one audit log record; actor, IP and user agent come from ctx.
type auditEntry struct {
	OrgID      *uuid.UUID
	ProjectID  *uuid.UUID
	Action     string
	TargetType string
	TargetID   string
	TargetName string
	Metadata   map[string]any
}

// audit records an action. Failures are logged, not returned: the action
// itself has already happened.
func (h *handlers) audit(ctx context.Context, q *db.Queries, e auditEntry) {
	info := reqInfo(ctx)
	params := db.InsertAuditLogParams{
		OrganizationID: e.OrgID,
		ProjectID:      e.ProjectID,
		Action:         e.Action,
		TargetType:     e.TargetType,
		TargetID:       e.TargetID,
		TargetName:     e.TargetName,
		Metadata:       []byte("{}"),
		Ip:             info.IP,
		UserAgent:      info.UserAgent,
	}
	if info.Principal != nil {
		id := info.Principal.User.ID
		params.ActorID = &id
		params.ActorUsername = info.Principal.User.Username
	}
	if e.Metadata != nil {
		if raw, err := json.Marshal(e.Metadata); err == nil {
			params.Metadata = raw
		}
	}
	if q == nil {
		q = h.deps.Store.Queries
	}
	if err := q.InsertAuditLog(ctx, params); err != nil {
		h.deps.Logger.ErrorContext(ctx, "writing audit log", "action", e.Action, "err", err)
	}
}

func ptr[T any](v T) *T { return &v }
