package httpapi

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// When someone who could read a project's keys loses that access (removed,
// left, a lower role, or their account disabled), they may still have the
// keys, or have left code behind in a function: a function deploy can read
// them too, which is why deploying needs the same access. The project's
// admins are told to rotate its keys (Settings › API Keys) until a rotation
// covers the secret key and the JWT secret, or they dismiss it.

// keyAccess lists the projects of an organization whose keys a user can read.
func keyAccess(ctx context.Context, q *db.Queries, orgID, userID uuid.UUID) (map[uuid.UUID]bool, error) {
	out := map[uuid.UUID]bool{}
	role, err := q.GetMemberRole(ctx, db.GetMemberRoleParams{OrganizationID: orgID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	projects, err := q.ListProjectsInOrganizations(ctx, []uuid.UUID{orgID})
	if err != nil {
		return nil, err
	}
	rows, err := q.ListUserProjectRoles(ctx, userID)
	if err != nil {
		return nil, err
	}
	projectRoles := map[uuid.UUID]*rbac.Role{}
	for _, r := range rows {
		role := rbac.Role(r.Role)
		projectRoles[r.ProjectID] = &role
	}
	for _, p := range projects {
		if rbac.ProjectCan(rbac.EffectiveProjectRole(rbac.Role(role), projectRoles[p.Project.ID]), rbac.ProjectSecretsRead) {
			out[p.Project.ID] = true
		}
	}
	return out, nil
}

// adviseRotation records an advisory for each project in before that's not in after.
func adviseRotation(ctx context.Context, q *db.Queries, before, after map[uuid.UUID]bool, username, reason string) error {
	for id := range before {
		if after[id] {
			continue
		}
		if err := q.AddRotationAdvisory(ctx, db.AddRotationAdvisoryParams{ProjectID: id, Username: username, Reason: reason}); err != nil {
			return err
		}
	}
	return nil
}

// adviseRotationForUser records advisories for every project, in any
// organization, whose keys a user could read (their account is being disabled).
func adviseRotationForUser(ctx context.Context, q *db.Queries, user db.User, reason string) error {
	orgs, err := q.ListOrganizationsForUser(ctx, user.ID)
	if err != nil {
		return err
	}
	for _, o := range orgs {
		before, err := keyAccess(ctx, q, o.Organization.ID, user.ID)
		if err != nil {
			return err
		}
		if err := adviseRotation(ctx, q, before, nil, user.Username, reason); err != nil {
			return err
		}
	}
	return nil
}

// rotationClears reports whether a rotation answers the advisories: the
// keys that give full access (the secret key, and the JWT secret behind
// the service_role key) are new.
func rotationClears(which []provision.Rotation) bool {
	return slices.Contains(which, provision.RotateSecretKey) && slices.Contains(which, provision.RotateJWTSecret)
}

func (h *handlers) ListRotationAdvisories(ctx context.Context, req api.ListRotationAdvisoriesRequestObject) (api.ListRotationAdvisoriesResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectSecretsRead, "view this project's keys")
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListRotationAdvisories(ctx, a.Project().ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListRotationAdvisories200JSONResponse, len(rows))
	for i, r := range rows {
		out[i] = api.RotationAdvisory{Username: r.Username, Reason: api.RotationAdvisoryReason(r.Reason), CreatedAt: r.CreatedAt}
	}
	return out, nil
}

func (h *handlers) DismissRotationAdvisories(ctx context.Context, req api.DismissRotationAdvisoriesRequestObject) (api.DismissRotationAdvisoriesResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "change project settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	n, err := h.deps.Store.Queries.ClearRotationAdvisories(ctx, db.ClearRotationAdvisoriesParams{ProjectID: p.ID, Before: time.Now()})
	if err != nil {
		return nil, err
	}
	if n > 0 {
		h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.rotation_advice_dismissed",
			TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"advisories": n}})
	}
	return api.DismissRotationAdvisories204Response{}, nil
}
