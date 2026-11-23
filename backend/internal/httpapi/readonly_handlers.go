package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"supermixer/internal/api"
	"supermixer/internal/rbac"
	"supermixer/internal/stack"
	"supermixer/internal/store/db"
)

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// readOnlyLoginName is how the role logs in. Through Supavisor the user is
// "<role>.<tenant>", like the admin user "postgres.<tenant>".
func readOnlyLoginName(role, adminUser string) string {
	if i := strings.IndexByte(adminUser, '.'); i >= 0 {
		return role + adminUser[i:]
	}
	return role
}

// roleOf strips the pooler's tenant suffix from a login name.
func roleOf(login string) string {
	if i := strings.IndexByte(login, '.'); i >= 0 {
		return login[:i]
	}
	return login
}

// saveConnection re-seals a project's connection and stores it.
func (h *handlers) saveConnection(ctx context.Context, p db.Project, conn stack.Connection) (db.Project, error) {
	sealed, err := h.seal(p.Ref, conn)
	if err != nil {
		return p, err
	}
	updated, err := h.deps.Store.Queries.UpdateProject(ctx, db.UpdateProjectParams{
		ID: p.ID, Name: p.Name, ApiUrl: p.ApiUrl, StudioUrl: p.StudioUrl, DbHost: p.DbHost, DbPort: p.DbPort,
		DbName: p.DbName, DbUser: p.DbUser, DbSslmode: p.DbSslmode, Secrets: sealed,
	})
	h.pools.Forget(p.Ref)
	return updated, err
}

func (h *handlers) adminSQL(ctx context.Context, ref string, d stack.Database, sql string) error {
	_, err := h.pools.Query(ctx, ref, d, sql, stack.QueryOptions{})
	var qe *stack.QueryError
	if errors.As(err, &qe) {
		return badRequest("the database refused: %s", qe.Message)
	}
	if err != nil {
		return newError(502, "could not reach the project's database: %s", stack.Describe(err))
	}
	return nil
}

func (h *handlers) CreateReadOnlyUser(ctx context.Context, req api.CreateReadOnlyUserRequestObject) (api.CreateReadOnlyUserResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "change project settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	conn, err := h.connection(p)
	if err != nil {
		return nil, err
	}
	if conn.ReadOnly != nil {
		return nil, conflict("this project already has a read-only user (%s)", conn.ReadOnly.User)
	}
	// A fresh name every time: Supavisor caches login secrets, so reusing a
	// name with a new password could be refused for a while.
	role := "supermixer_ro_" + randomHex(4)
	password := randomHex(24) // hex only, so it is safe inside the literal below
	create := fmt.Sprintf(`create role %s login password '%s' bypassrls;
grant pg_read_all_data to %s;
comment on role %s is 'Supermixer: read-only queries for project members with the Read-only role'`, role, password, role, role)
	if err := h.adminSQL(ctx, p.Ref, conn.Database, create); err != nil {
		return nil, err
	}
	login := stack.Login{User: readOnlyLoginName(role, conn.Database.User), Password: password}
	drop := func() { _ = h.adminSQL(context.WithoutCancel(ctx), p.Ref, conn.Database, "drop role if exists "+role) }

	// Prove it works before relying on it.
	res, err := h.pools.Query(ctx, p.Ref+stack.ReadOnlyPoolSuffix, conn.Database.As(login), "select current_user::text", stack.QueryOptions{ReadOnly: true})
	h.pools.Forget(p.Ref)
	if err != nil || len(res) == 0 || len(res[0].Rows) == 0 || res[0].Rows[0][0] != role {
		drop()
		if err == nil {
			err = errors.New("unexpected user")
		}
		return nil, badRequest("created %s but could not sign in as it (%s); it was removed again", role, stack.Describe(err))
	}

	conn.ReadOnly = &login
	updated, err := h.saveConnection(ctx, p, conn)
	if err != nil {
		drop()
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{
		OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.read_only_user_created",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"role": role},
	})
	out, err := h.toProject(updated, a.Row.OrganizationSlug, a.Row.OrganizationName, a.Role)
	return api.CreateReadOnlyUser200JSONResponse(out), err
}

func (h *handlers) DeleteReadOnlyUser(ctx context.Context, req api.DeleteReadOnlyUserRequestObject) (api.DeleteReadOnlyUserResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "change project settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	conn, err := h.connection(p)
	if err != nil {
		return nil, err
	}
	if conn.ReadOnly == nil {
		return nil, notFound("read-only user")
	}
	role := roleOf(conn.ReadOnly.User)
	h.pools.Forget(p.Ref) // close its connections so the role can be dropped
	if err := h.adminSQL(ctx, p.Ref, conn.Database, "drop role if exists "+stackIdent(role)); err != nil {
		return nil, err
	}
	conn.ReadOnly = nil
	updated, err := h.saveConnection(ctx, p, conn)
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{
		OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.read_only_user_removed",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"role": role},
	})
	out, err := h.toProject(updated, a.Row.OrganizationSlug, a.Row.OrganizationName, a.Role)
	return api.DeleteReadOnlyUser200JSONResponse(out), err
}

// stackIdent quotes an identifier for SQL.
func stackIdent(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
