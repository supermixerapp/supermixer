package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/rbac"
	"supermixer/internal/stack"
	"supermixer/internal/store/db"
)

func (h *handlers) RunQuery(ctx context.Context, req api.RunQueryRequestObject) (api.RunQueryResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectDataRead, "run queries on this project")
	if err != nil {
		return nil, err
	}
	body := req.Body
	if strings.TrimSpace(body.Query) == "" {
		return nil, badRequest("the query is empty")
	}
	conn, err := h.connection(a.Project())
	if err != nil {
		return nil, err
	}
	opt := stack.QueryOptions{
		ReadOnly: !rbac.ProjectCan(a.Role, rbac.ProjectDataWrite) || (body.ReadOnly != nil && *body.ReadOnly),
		MaxRows:  h.deps.Config.Projects.QueryMaxRows,
		Timeout:  h.deps.Config.Projects.QueryTimeout,
	}
	// The spec's limits aren't enforced by the router, so check them here.
	if body.MaxRows != nil {
		if *body.MaxRows < 1 || *body.MaxRows > maxQueryRows {
			return nil, badRequest("max_rows must be between 1 and %d", maxQueryRows)
		}
		opt.MaxRows = *body.MaxRows
	}
	if len(body.Query) > maxQueryBytes {
		return nil, badRequest("the query is longer than %d bytes", maxQueryBytes)
	}
	if body.Params != nil {
		opt.Params = *body.Params
	}
	start := time.Now()
	// Read-only queries use the project's low-privilege login when it has one;
	// otherwise the read-only transaction alone keeps data unchanged.
	poolKey, database := a.Project().Ref, conn.Database
	if opt.ReadOnly && conn.ReadOnly != nil {
		poolKey, database = poolKey+stack.ReadOnlyPoolSuffix, conn.Database.As(*conn.ReadOnly)
	}
	// A run that can write may create or change Postgres logins; see role_audit.go.
	var rolesBefore *dbRoles
	if !opt.ReadOnly {
		rolesBefore = h.rolesBeforeRun(ctx, a, poolKey, database, body.Query)
	}
	results, err := h.pools.Query(ctx, poolKey, database, body.Query, opt)
	if rolesBefore != nil {
		h.auditRoleChanges(ctx, a, poolKey, database, body.Query, rolesBefore, err)
	}
	var qe *stack.QueryError
	switch {
	case errors.As(err, &qe):
		return api.RunQuery422JSONResponse(toQueryError(qe)), nil
	case err != nil:
		h.deps.Logger.WarnContext(ctx, "project database unreachable", "ref", a.Project().Ref, "err", err)
		return nil, newError(http.StatusBadGateway, "could not reach the project's database: %s", stack.Describe(err))
	}
	out := api.QueryResponse{ReadOnly: opt.ReadOnly, DurationMs: time.Since(start).Milliseconds(), Results: make([]api.QueryResult, len(results))}
	for i, r := range results {
		cols := make([]api.QueryColumn, len(r.Columns))
		for j, c := range r.Columns {
			cols[j] = api.QueryColumn{Name: c.Name, Type: c.Type}
		}
		res := api.QueryResult{Command: r.Command, RowCount: r.RowCount, Columns: cols, Rows: make([][]interface{}, len(r.Rows)), Truncated: r.Truncated}
		for j, row := range r.Rows {
			res.Rows[j] = row
		}
		if len(r.Notices) > 0 {
			res.Notices = &r.Notices
		}
		out.Results[i] = res
	}
	return api.RunQuery200JSONResponse(out), nil
}

const (
	maxQueryRows  = 10000
	maxQueryBytes = 1_000_000
)

func validVisibility(v *api.SnippetVisibility) (db.SnippetVisibility, error) {
	switch *v {
	case api.SnippetVisibilityPrivate, api.SnippetVisibilityProject:
		return db.SnippetVisibility(*v), nil
	}
	return "", badRequest("visibility must be private or project")
}

func toQueryError(e *stack.QueryError) api.QueryError {
	out := api.QueryError{Message: e.Message}
	if e.Code != "" {
		out.Code = &e.Code
	}
	if e.Detail != "" {
		out.Detail = &e.Detail
	}
	if e.Hint != "" {
		out.Hint = &e.Hint
	}
	if e.Position > 0 {
		pos := int(e.Position)
		out.Position = &pos
	}
	return out
}

// ----------------------------------------------------------------- snippets

func validSnippetName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || len([]rune(s)) > 128 {
		return "", badRequest("a snippet name needs 1 to 128 characters")
	}
	return s, nil
}

func toSnippet(s db.SqlSnippet, owner string, favorite bool, userID [16]byte, withContent bool) api.Snippet {
	out := api.Snippet{
		Id: s.ID, Name: s.Name, Visibility: api.SnippetVisibility(s.Visibility), OwnerId: s.OwnerID, OwnerUsername: owner,
		CanEdit: s.OwnerID == userID, Favorite: &favorite, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt,
	}
	if withContent {
		out.Content = &s.Content
	}
	return out
}

func (h *handlers) ListSnippets(ctx context.Context, req api.ListSnippetsRequestObject) (api.ListSnippetsResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectDataRead, "use the SQL Editor")
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListSnippets(ctx, db.ListSnippetsParams{ProjectID: a.Project().ID, UserID: a.User.User.ID})
	if err != nil {
		return nil, err
	}
	out := make(api.ListSnippets200JSONResponse, len(rows))
	for i, r := range rows {
		s := db.SqlSnippet{ID: r.ID, Name: r.Name, Visibility: r.Visibility, OwnerID: r.OwnerID, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
		out[i] = toSnippet(s, r.OwnerUsername, r.Favorite, a.User.User.ID, false)
	}
	return out, nil
}

func (h *handlers) CreateSnippet(ctx context.Context, req api.CreateSnippetRequestObject) (api.CreateSnippetResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectDataRead, "use the SQL Editor")
	if err != nil {
		return nil, err
	}
	name, err := validSnippetName(req.Body.Name)
	if err != nil {
		return nil, err
	}
	vis := db.SnippetVisibilityPrivate
	if req.Body.Visibility != nil {
		if vis, err = validVisibility(req.Body.Visibility); err != nil {
			return nil, err
		}
	}
	if len(req.Body.Content) > maxQueryBytes {
		return nil, badRequest("the snippet is longer than %d bytes", maxQueryBytes)
	}
	s, err := h.deps.Store.Queries.CreateSnippet(ctx, db.CreateSnippetParams{
		ProjectID: a.Project().ID, OwnerID: a.User.User.ID, Name: name, Content: req.Body.Content, Visibility: vis,
	})
	if err != nil {
		return nil, err
	}
	return api.CreateSnippet201JSONResponse(toSnippet(s, a.User.User.Username, false, a.User.User.ID, true)), nil
}

// loadSnippet finds a snippet the caller can see in the project.
func (h *handlers) loadSnippet(ctx context.Context, ref string, id [16]byte) (*projectAccess, db.GetSnippetRow, error) {
	a, err := h.loadProject(ctx, ref, rbac.ProjectDataRead, "use the SQL Editor")
	if err != nil {
		return nil, db.GetSnippetRow{}, err
	}
	row, err := h.deps.Store.Queries.GetSnippet(ctx, db.GetSnippetParams{ID: id, ProjectID: a.Project().ID, UserID: a.User.User.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, row, notFound("snippet")
	}
	return a, row, err
}

func (h *handlers) GetSnippet(ctx context.Context, req api.GetSnippetRequestObject) (api.GetSnippetResponseObject, error) {
	a, row, err := h.loadSnippet(ctx, req.Ref, req.SnippetId)
	if err != nil {
		return nil, err
	}
	return api.GetSnippet200JSONResponse(toSnippet(row.SqlSnippet, row.OwnerUsername, row.Favorite, a.User.User.ID, true)), nil
}

func (h *handlers) UpdateSnippet(ctx context.Context, req api.UpdateSnippetRequestObject) (api.UpdateSnippetResponseObject, error) {
	a, row, err := h.loadSnippet(ctx, req.Ref, req.SnippetId)
	if err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	userID := a.User.User.ID
	s := row.SqlSnippet
	b := req.Body
	if b.Name != nil || b.Content != nil || b.Visibility != nil {
		if s.OwnerID != userID {
			return nil, forbidden("change a snippet someone else owns")
		}
		if b.Name != nil {
			if s.Name, err = validSnippetName(*b.Name); err != nil {
				return nil, err
			}
		}
		if b.Content != nil {
			if len(*b.Content) > maxQueryBytes {
				return nil, badRequest("the snippet is longer than %d bytes", maxQueryBytes)
			}
			s.Content = *b.Content
		}
		if b.Visibility != nil {
			if s.Visibility, err = validVisibility(b.Visibility); err != nil {
				return nil, err
			}
		}
		if s, err = q.UpdateSnippet(ctx, db.UpdateSnippetParams{ID: s.ID, Name: s.Name, Content: s.Content, Visibility: s.Visibility}); err != nil {
			return nil, err
		}
	}
	fav := row.Favorite
	if b.Favorite != nil && *b.Favorite != fav {
		fav = *b.Favorite
		if fav {
			err = q.SetSnippetFavorite(ctx, db.SetSnippetFavoriteParams{UserID: userID, SnippetID: s.ID})
		} else {
			err = q.UnsetSnippetFavorite(ctx, db.UnsetSnippetFavoriteParams{UserID: userID, SnippetID: s.ID})
		}
		if err != nil {
			return nil, err
		}
	}
	return api.UpdateSnippet200JSONResponse(toSnippet(s, row.OwnerUsername, fav, userID, true)), nil
}

func (h *handlers) DeleteSnippet(ctx context.Context, req api.DeleteSnippetRequestObject) (api.DeleteSnippetResponseObject, error) {
	a, row, err := h.loadSnippet(ctx, req.Ref, req.SnippetId)
	if err != nil {
		return nil, err
	}
	// Owners delete their own; project admins can tidy up shared ones.
	if row.SqlSnippet.OwnerID != a.User.User.ID && !rbac.ProjectCan(a.Role, rbac.ProjectUpdate) {
		return nil, forbidden("delete a snippet someone else owns")
	}
	if err := h.deps.Store.Queries.DeleteSnippet(ctx, row.SqlSnippet.ID); err != nil {
		return nil, err
	}
	return api.DeleteSnippet204Response{}, nil
}
