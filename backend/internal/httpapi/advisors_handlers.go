package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"time"

	"supermixer/internal/advisors"
	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/stack"
)

var lintOrder = map[string]int{"ERROR": 0, "WARN": 1, "INFO": 2}

// ListLints runs splinter. It is Supermixer's own SQL, so it may hold several
// statements; it runs in a read-only transaction as the admin user, whose
// view of the catalog the checks were written for.
func (h *handlers) ListLints(ctx context.Context, req api.ListLintsRequestObject) (api.ListLintsResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectDataRead, "view this project's advisors")
	if err != nil {
		return nil, err
	}
	conn, err := h.connection(a.Project())
	if err != nil {
		return nil, err
	}
	results, err := h.pools.Query(ctx, a.Project().Ref, conn.Database, advisors.SQL, stack.QueryOptions{
		ReadOnly: true,
		Trusted:  true,
		MaxRows:  maxQueryRows,
		Timeout:  h.deps.Config.Projects.QueryTimeout,
	})
	var qe *stack.QueryError
	switch {
	case errors.As(err, &qe):
		return api.ListLints422JSONResponse(toQueryError(qe)), nil
	case err != nil:
		h.deps.Logger.WarnContext(ctx, "project database unreachable", "ref", a.Project().Ref, "err", err)
		return nil, newError(http.StatusBadGateway, "could not reach the project's database: %s", stack.Describe(err))
	case len(results) == 0:
		return nil, errors.New("splinter returned no result")
	}
	lints, err := advisors.FromResult(results[len(results)-1])
	if err != nil {
		return nil, err
	}
	k := conn.Keys
	if l := advisors.ExampleSecretsLint(provision.ExampleSecrets(k.JWTSecret, k.Anon, k.ServiceRole, conn.Database.Password)); l != nil {
		lints = append(lints, *l)
	}
	sort.SliceStable(lints, func(i, j int) bool {
		if lintOrder[lints[i].Level] != lintOrder[lints[j].Level] {
			return lintOrder[lints[i].Level] < lintOrder[lints[j].Level]
		}
		return lints[i].Title < lints[j].Title
	})
	out := api.ListLints200JSONResponse{Lints: make([]api.Lint, len(lints)), RanAt: time.Now().UTC()}
	for i, l := range lints {
		meta := map[string]any{}
		_ = json.Unmarshal(l.Metadata, &meta)
		cats := make([]api.LintCategories, len(l.Categories))
		for j, c := range l.Categories {
			cats[j] = api.LintCategories(c)
		}
		out.Lints[i] = api.Lint{
			Name: l.Name, Title: l.Title, Level: api.LintLevel(l.Level), Facing: api.LintFacing(l.Facing), Categories: cats,
			Description: l.Description, Detail: l.Detail, Remediation: l.Remediation, Metadata: meta, CacheKey: l.CacheKey,
		}
	}
	return out, nil
}
