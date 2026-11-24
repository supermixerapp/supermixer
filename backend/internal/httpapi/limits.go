package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Resource limits (Instance › Resource Limits, and an organization's own
// project limit). The instance's are kept in instance_settings; an
// organization's in organizations.max_projects, at most the instance's.
// Lowering a limit keeps what exists and stops new ones past it.
//
// Checks run in the transaction that adds the organization or project, after
// locking the person's or the organization's row, so two requests at once
// can't both slip under the limit.

const (
	limitsKey = "resource_limits"
	maxLimit  = 100000
)

// instanceLimits are the instance's limits; nil is unlimited.
type instanceLimits struct {
	MaxOrgsPerUser    *int `json:"max_organizations_per_user,omitempty"`
	MaxProjectsPerOrg *int `json:"max_projects_per_organization,omitempty"`
}

func readInstanceLimits(ctx context.Context, q *db.Queries) (instanceLimits, error) {
	var l instanceLimits
	row, err := q.GetInstanceSetting(ctx, limitsKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return l, nil
	} else if err != nil {
		return l, err
	}
	return l, json.Unmarshal(row.Value, &l)
}

// projectLimit is the lower of the instance's limit and an organization's own.
func projectLimit(inst instanceLimits, own *int32) *int {
	limit := inst.MaxProjectsPerOrg
	if own != nil && (limit == nil || int(*own) < *limit) {
		n := int(*own)
		limit = &n
	}
	return limit
}

func limitReached(format string, a ...any) error {
	return &apiError{status: http.StatusForbidden, code: "limit_reached", message: fmt.Sprintf(format, a...)}
}

func countOf(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// checkOrganizationLimit refuses a new organization past the person's limit.
// Instance admins aren't held to it. Call it in the transaction that creates
// the organization.
func checkOrganizationLimit(ctx context.Context, q *db.Queries, user db.User) error {
	if user.IsInstanceAdmin {
		return nil
	}
	l, err := readInstanceLimits(ctx, q)
	if err != nil || l.MaxOrgsPerUser == nil {
		return err
	}
	if _, err := q.LockUserForLimits(ctx, user.ID); err != nil {
		return err
	}
	n, err := q.CountOrganizationsCreatedBy(ctx, &user.ID)
	if err != nil {
		return err
	}
	if int(n) >= *l.MaxOrgsPerUser {
		return limitReached("you can create at most %s on this instance, and you've reached that; ask an instance admin to raise the limit",
			countOf(*l.MaxOrgsPerUser, "organization", "organizations"))
	}
	return nil
}

// checkProjectLimit refuses another project in an organization at its limit.
// Call it in the transaction that adds the project.
func checkProjectLimit(ctx context.Context, q *db.Queries, orgID uuid.UUID, orgName string) error {
	own, err := q.LockOrganizationForLimits(ctx, orgID)
	if err != nil {
		return err
	}
	l, err := readInstanceLimits(ctx, q)
	if err != nil {
		return err
	}
	limit := projectLimit(l, own)
	if limit == nil {
		return nil
	}
	n, err := q.CountOrganizationProjects(ctx, orgID)
	if err != nil {
		return err
	}
	if int(n) >= *limit {
		return limitReached("%s can have at most %s, and has reached that; remove a project or raise the limit first",
			orgName, countOf(*limit, "project", "projects"))
	}
	return nil
}

func (h *handlers) resourceLimitsOut(ctx context.Context, q *db.Queries) (api.ResourceLimits, error) {
	l, err := readInstanceLimits(ctx, q)
	if err != nil {
		return api.ResourceLimits{}, err
	}
	orgs, err := q.MostOrganizationsCreatedByOnePerson(ctx)
	if err != nil {
		return api.ResourceLimits{}, err
	}
	projects, err := q.MostProjectsInOneOrganization(ctx)
	if err != nil {
		return api.ResourceLimits{}, err
	}
	return api.ResourceLimits{MaxOrganizationsPerUser: l.MaxOrgsPerUser, MaxProjectsPerOrganization: l.MaxProjectsPerOrg,
		MostOrganizationsByOnePerson: int(orgs), MostProjectsInOneOrganization: int(projects)}, nil
}

func (h *handlers) GetResourceLimits(ctx context.Context, _ api.GetResourceLimitsRequestObject) (api.GetResourceLimitsResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	out, err := h.resourceLimitsOut(ctx, h.deps.Store.Queries)
	if err != nil {
		return nil, err
	}
	return api.GetResourceLimits200JSONResponse(out), nil
}

func validLimit(name string, n *int) error {
	if n != nil && (*n < 1 || *n > maxLimit) {
		return badRequest("%s must be between 1 and %d, or unlimited", name, maxLimit)
	}
	return nil
}

func (h *handlers) SetResourceLimits(ctx context.Context, req api.SetResourceLimitsRequestObject) (api.SetResourceLimitsResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	l := instanceLimits{MaxOrgsPerUser: req.Body.MaxOrganizationsPerUser, MaxProjectsPerOrg: req.Body.MaxProjectsPerOrganization}
	if err := validLimit("the organizations per person", l.MaxOrgsPerUser); err != nil {
		return nil, err
	}
	if err := validLimit("the projects per organization", l.MaxProjectsPerOrg); err != nil {
		return nil, err
	}
	value, err := json.Marshal(l)
	if err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	if err := q.SetInstanceSetting(ctx, db.SetInstanceSettingParams{Key: limitsKey, Value: value}); err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "instance.limits_updated", TargetType: "instance", TargetName: "Resource limits",
		Metadata: map[string]any{"max_organizations_per_user": l.MaxOrgsPerUser, "max_projects_per_organization": l.MaxProjectsPerOrg}})
	out, err := h.resourceLimitsOut(ctx, q)
	if err != nil {
		return nil, err
	}
	return api.SetResourceLimits200JSONResponse(out), nil
}

func (h *handlers) GetMyLimits(ctx context.Context, _ api.GetMyLimitsRequestObject) (api.GetMyLimitsResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	n, err := q.CountOrganizationsCreatedBy(ctx, &p.User.ID)
	if err != nil {
		return nil, err
	}
	out := api.MyLimits{OrganizationsCreated: int(n)}
	if !p.User.IsInstanceAdmin {
		l, err := readInstanceLimits(ctx, q)
		if err != nil {
			return nil, err
		}
		out.MaxOrganizations = l.MaxOrgsPerUser
	}
	return api.GetMyLimits200JSONResponse(out), nil
}

func (h *handlers) organizationLimitsOut(ctx context.Context, q *db.Queries, org db.Organization) (api.OrganizationLimits, error) {
	l, err := readInstanceLimits(ctx, q)
	if err != nil {
		return api.OrganizationLimits{}, err
	}
	n, err := q.CountOrganizationProjects(ctx, org.ID)
	if err != nil {
		return api.OrganizationLimits{}, err
	}
	out := api.OrganizationLimits{InstanceMaxProjects: l.MaxProjectsPerOrg, ProjectLimit: projectLimit(l, org.MaxProjects), ProjectCount: int(n)}
	if org.MaxProjects != nil {
		own := int(*org.MaxProjects)
		out.MaxProjects = &own
	}
	return out, nil
}

func (h *handlers) GetOrganizationLimits(ctx context.Context, req api.GetOrganizationLimitsRequestObject) (api.GetOrganizationLimitsResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgRead, "view this organization")
	if err != nil {
		return nil, err
	}
	out, err := h.organizationLimitsOut(ctx, h.deps.Store.Queries, a.Org)
	if err != nil {
		return nil, err
	}
	return api.GetOrganizationLimits200JSONResponse(out), nil
}

func (h *handlers) SetOrganizationLimits(ctx context.Context, req api.SetOrganizationLimitsRequestObject) (api.SetOrganizationLimitsResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgLimitsUpdate, "change this organization's limits")
	if err != nil {
		return nil, err
	}
	max := req.Body.MaxProjects
	if err := validLimit("the project limit", max); err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	l, err := readInstanceLimits(ctx, q)
	if err != nil {
		return nil, err
	}
	if max != nil && l.MaxProjectsPerOrg != nil && *max > *l.MaxProjectsPerOrg {
		return nil, badRequest("this instance allows at most %s per organization", countOf(*l.MaxProjectsPerOrg, "project", "projects"))
	}
	var own *int32
	if max != nil {
		n := int32(*max)
		own = &n
	}
	if err := q.SetOrganizationMaxProjects(ctx, db.SetOrganizationMaxProjectsParams{ID: a.Org.ID, MaxProjects: own}); err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{OrgID: &a.Org.ID, Action: "organization.limits_updated", TargetType: "organization",
		TargetID: a.Org.Slug, TargetName: a.Org.Name, Metadata: map[string]any{"max_projects": max}})
	org := a.Org
	org.MaxProjects = own
	out, err := h.organizationLimitsOut(ctx, q, org)
	if err != nil {
		return nil, err
	}
	return api.SetOrganizationLimits200JSONResponse(out), nil
}
