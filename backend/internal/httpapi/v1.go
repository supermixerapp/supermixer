package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"supermixer/internal/api"
)

// The Supabase-style Management API (Stage 5.4), at /v1 as at
// api.supabase.com/v1: a subset of its paths and response shapes, for
// scripts and tools written against Supabase's. Each route calls one of
// Supermixer's own handlers, so permissions, checks and the audit log are
// the same as in the app. It takes personal access tokens only.
//
// Supermixer's own API (/api/v1) covers everything else, and takes the same
// tokens.

// v1Route handles a /v1 request, returning the response body and status.
type v1Route func(r *http.Request) (any, int, error)

func (h *handlers) managementAPI() http.Handler {
	r := chi.NewRouter()
	r.Use(h.sessionMiddleware)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if p := reqInfo(r.Context()).Principal; p == nil || p.AccessToken == nil {
				writeError(w, http.StatusUnauthorized, "use a personal access token: Authorization: Bearer sbp_… (Account › Access Tokens)")
				return
			}
			next.ServeHTTP(w, r)
		})
	})
	route := func(f v1Route) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			body, status, err := f(r)
			if err != nil {
				code, apiCode, msg, expected := errorStatus(err)
				if !expected {
					h.deps.Logger.ErrorContext(r.Context(), "management API", "path", r.URL.Path, "err", err)
				}
				writeErrorCode(w, code, apiCode, msg)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(body)
		}
	}
	r.Get("/organizations", route(h.v1Organizations))
	r.Get("/organizations/{slug}", route(h.v1Organization))
	r.Get("/organizations/{slug}/members", route(h.v1Members))
	r.Get("/projects", route(h.v1Projects))
	r.Get("/projects/{ref}", route(h.v1Project))
	r.Get("/projects/{ref}/health", route(h.v1Health))
	r.Get("/projects/{ref}/api-keys", route(h.v1APIKeys))
	r.Post("/projects/{ref}/database/query", route(h.v1Query))
	r.Get("/projects/{ref}/database/backups", route(h.v1Backups))
	r.Get("/projects/{ref}/functions", route(h.v1Functions))
	r.Get("/projects/{ref}/functions/{slug}", route(h.v1Function))
	r.Delete("/projects/{ref}/functions/{slug}", route(h.v1DeleteFunction))
	r.Get("/projects/{ref}/secrets", route(h.v1Secrets))
	r.Post("/projects/{ref}/secrets", route(h.v1SetSecrets))
	r.Delete("/projects/{ref}/secrets", route(h.v1DeleteSecrets))
	r.Post("/projects/{ref}/pause", route(h.v1StackAction("stop")))
	r.Post("/projects/{ref}/restore", route(h.v1StackAction("start")))
	r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not in Supermixer's subset of the Management API; see /api/v1 for Supermixer's own")
	})
	return r
}

// unexpected is for a handler answering with a type the wrapper doesn't know.
func unexpected(resp any) error { return fmt.Errorf("unexpected response %T", resp) }

// decode reads a JSON body into v, limited to 1 MiB.
func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		return badRequest("the body isn't the JSON this expects: %s", err.Error())
	}
	return nil
}

// --- Organizations

type v1Org struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (h *handlers) v1Organizations(r *http.Request) (any, int, error) {
	resp, err := h.ListOrganizations(r.Context(), api.ListOrganizationsRequestObject{})
	if err != nil {
		return nil, 0, err
	}
	orgs, ok := resp.(api.ListOrganizations200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	out := make([]v1Org, len(orgs))
	for i, o := range orgs {
		out[i] = v1Org{ID: o.Slug, Name: o.Name}
	}
	return out, http.StatusOK, nil
}

func (h *handlers) v1Organization(r *http.Request) (any, int, error) {
	resp, err := h.GetOrganization(r.Context(), api.GetOrganizationRequestObject{Slug: chi.URLParam(r, "slug")})
	if err != nil {
		return nil, 0, err
	}
	o, ok := resp.(api.GetOrganization200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	return v1Org{ID: o.Slug, Name: o.Name}, http.StatusOK, nil
}

func (h *handlers) v1Members(r *http.Request) (any, int, error) {
	resp, err := h.ListMembers(r.Context(), api.ListMembersRequestObject{Slug: chi.URLParam(r, "slug")})
	if err != nil {
		return nil, 0, err
	}
	members, ok := resp.(api.ListMembers200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	type member struct {
		UserID     string  `json:"user_id"`
		UserName   string  `json:"user_name"`
		Email      *string `json:"email"`
		RoleName   string  `json:"role_name"`
		MfaEnabled bool    `json:"mfa_enabled"`
	}
	out := make([]member, len(members))
	for i, m := range members {
		out[i] = member{UserID: m.UserId.String(), UserName: m.Username, Email: m.Email, RoleName: describeRoleName(string(m.Role)), MfaEnabled: m.MfaEnabled}
	}
	return out, http.StatusOK, nil
}

// describeRoleName is a role as Supabase names it.
func describeRoleName(role string) string {
	return map[string]string{"owner": "Owner", "administrator": "Administrator", "developer": "Developer",
		"read_only": "Read-only", "no_access": "No access"}[role]
}

// --- Projects

type v1Project struct {
	ID               string `json:"id"`
	Ref              string `json:"ref"`
	OrganizationID   string `json:"organization_id"`
	OrganizationSlug string `json:"organization_slug"`
	Name             string `json:"name"`
	Region           string `json:"region"`
	CreatedAt        string `json:"created_at"`
	// Status is Supabase's: ACTIVE_HEALTHY, COMING_UP, INACTIVE (paused),
	// INIT_FAILED or GOING_DOWN. Projects Supermixer connected to (rather
	// than created) are ACTIVE_HEALTHY; /health checks them.
	Status   string `json:"status"`
	Database struct {
		Host string `json:"host"`
		Port int    `json:"port"`
	} `json:"database"`
	APIURL string `json:"api_url"`
}

func toV1Project(p api.Project) v1Project {
	out := v1Project{
		ID: p.Ref, Ref: p.Ref, OrganizationID: p.OrganizationSlug, OrganizationSlug: p.OrganizationSlug, Name: p.Name,
		Region: "self-hosted", CreatedAt: p.CreatedAt.UTC().Format(time.RFC3339), Status: "ACTIVE_HEALTHY", APIURL: p.ApiUrl,
	}
	if p.Stack != nil {
		out.Status = map[api.StackStatus]string{
			api.StackStatusProvisioning: "COMING_UP", api.StackStatusRunning: "ACTIVE_HEALTHY", api.StackStatusPaused: "INACTIVE",
			api.StackStatusFailed: "INIT_FAILED", api.StackStatusDeleting: "GOING_DOWN",
		}[p.Stack.Status]
	}
	out.Database.Host, out.Database.Port = p.Database.Host, p.Database.Port
	return out
}

func (h *handlers) v1Projects(r *http.Request) (any, int, error) {
	resp, err := h.ListProjects(r.Context(), api.ListProjectsRequestObject{})
	if err != nil {
		return nil, 0, err
	}
	projects, ok := resp.(api.ListProjects200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	out := make([]v1Project, len(projects))
	for i, p := range projects {
		out[i] = toV1Project(p)
	}
	return out, http.StatusOK, nil
}

func (h *handlers) v1Project(r *http.Request) (any, int, error) {
	resp, err := h.GetProject(r.Context(), api.GetProjectRequestObject{Ref: chi.URLParam(r, "ref")})
	if err != nil {
		return nil, 0, err
	}
	p, ok := resp.(api.GetProject200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	return toV1Project(api.Project(p)), http.StatusOK, nil
}

func (h *handlers) v1Health(r *http.Request) (any, int, error) {
	resp, err := h.GetProjectHealth(r.Context(), api.GetProjectHealthRequestObject{Ref: chi.URLParam(r, "ref")})
	if err != nil {
		return nil, 0, err
	}
	report, ok := resp.(api.GetProjectHealth200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	// Supabase's service names; ?services=auth,db,... picks some.
	names := map[api.ServiceCheckService]string{"auth": "auth", "rest": "rest", "storage": "storage", "database": "db", "meta": "pg_meta"}
	want := map[string]bool{}
	for _, s := range strings.Split(r.URL.Query().Get("services"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}
	type service struct {
		Name    string  `json:"name"`
		Healthy bool    `json:"healthy"`
		Status  string  `json:"status"`
		Error   *string `json:"error,omitempty"`
	}
	out := []service{}
	for _, c := range report.Services {
		name := names[c.Service]
		if name == "" || (len(want) > 0 && !want[name]) {
			continue
		}
		s := service{Name: name, Healthy: c.Status == "ok", Status: "ACTIVE_HEALTHY"}
		if !s.Healthy {
			s.Status, s.Error = "UNHEALTHY", c.Detail
		}
		out = append(out, s)
	}
	return out, http.StatusOK, nil
}

func (h *handlers) v1APIKeys(r *http.Request) (any, int, error) {
	ref := chi.URLParam(r, "ref")
	// Like Supabase, keys come with their values; someone who may not see
	// secret ones gets them without.
	reveal := r.URL.Query().Get("reveal") != "false"
	resp, err := h.ListApiKeys(r.Context(), api.ListApiKeysRequestObject{Ref: ref, Params: api.ListApiKeysParams{Reveal: &reveal}})
	if err != nil && reveal && isForbidden(err) {
		no := false
		resp, err = h.ListApiKeys(r.Context(), api.ListApiKeysRequestObject{Ref: ref, Params: api.ListApiKeysParams{Reveal: &no}})
	}
	if err != nil {
		return nil, 0, err
	}
	keys, ok := resp.(api.ListApiKeys200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	type key struct {
		Name   string  `json:"name"`
		APIKey *string `json:"api_key"`
		Type   string  `json:"type"`
		ID     string  `json:"id"`
	}
	out := []key{}
	for _, k := range keys {
		if !k.Present || k.Kind == "jwt_secret" {
			continue
		}
		t, name := "legacy", string(k.Id)
		if k.Kind == "api_key" {
			t, name = string(k.Id), "default"
		}
		out = append(out, key{Name: name, APIKey: k.Value, Type: t, ID: string(k.Id)})
	}
	return out, http.StatusOK, nil
}

func isForbidden(err error) bool {
	status, _, _, _ := errorStatus(err)
	return status == http.StatusForbidden
}

func (h *handlers) v1Query(r *http.Request) (any, int, error) {
	var body struct {
		Query    string `json:"query"`
		ReadOnly *bool  `json:"read_only"`
	}
	if err := decode(r, &body); err != nil {
		return nil, 0, err
	}
	resp, err := h.RunQuery(r.Context(), api.RunQueryRequestObject{Ref: chi.URLParam(r, "ref"), Body: &api.QueryRequest{Query: body.Query, ReadOnly: body.ReadOnly}})
	if err != nil {
		return nil, 0, err
	}
	res, ok := resp.(api.RunQuery200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	// Supabase answers with the last statement's rows, as objects.
	rows := []map[string]any{}
	if len(res.Results) > 0 {
		last := res.Results[len(res.Results)-1]
		for _, row := range last.Rows {
			m := make(map[string]any, len(row))
			for i, v := range row {
				if i < len(last.Columns) {
					m[last.Columns[i].Name] = v
				}
			}
			rows = append(rows, m)
		}
	}
	return rows, http.StatusCreated, nil
}

func (h *handlers) v1Backups(r *http.Request) (any, int, error) {
	resp, err := h.ListBackups(r.Context(), api.ListBackupsRequestObject{Ref: chi.URLParam(r, "ref")})
	if err != nil {
		return nil, 0, err
	}
	list, ok := resp.(api.ListBackups200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	type backup struct {
		ID               string `json:"id"`
		IsPhysicalBackup bool   `json:"is_physical_backup"`
		Status           string `json:"status"`
		InsertedAt       string `json:"inserted_at"`
		Kind             string `json:"kind"`
		SizeBytes        int64  `json:"size_bytes"`
	}
	out := struct {
		Region      string   `json:"region"`
		WalgEnabled bool     `json:"walg_enabled"`
		PitrEnabled bool     `json:"pitr_enabled"`
		Backups     []backup `json:"backups"`
	}{Region: "self-hosted", Backups: []backup{}}
	for _, b := range list.Backups {
		status := map[string]string{"running": "PENDING", "completed": "COMPLETED", "failed": "FAILED"}[string(b.Status)]
		out.Backups = append(out.Backups, backup{ID: b.Id.String(), Status: status, InsertedAt: b.StartedAt.UTC().Format(time.RFC3339),
			Kind: string(b.Kind), SizeBytes: b.SizeBytes})
	}
	return out, http.StatusOK, nil
}

// --- Edge Functions

type v1Fn struct {
	ID             string  `json:"id"`
	Slug           string  `json:"slug"`
	Name           string  `json:"name"`
	Status         string  `json:"status"`
	CreatedAt      int64   `json:"created_at"`
	UpdatedAt      int64   `json:"updated_at"`
	EntrypointPath *string `json:"entrypoint_path"`
}

func toV1Fn(f api.EdgeFunction) v1Fn {
	ms := f.UpdatedAt.UnixMilli()
	return v1Fn{ID: f.Name, Slug: f.Name, Name: f.Name, Status: "ACTIVE", CreatedAt: ms, UpdatedAt: ms, EntrypointPath: f.Entrypoint}
}

func (h *handlers) v1Functions(r *http.Request) (any, int, error) {
	resp, err := h.ListEdgeFunctions(r.Context(), api.ListEdgeFunctionsRequestObject{Ref: chi.URLParam(r, "ref")})
	if err != nil {
		return nil, 0, err
	}
	fns, ok := resp.(api.ListEdgeFunctions200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	out := make([]v1Fn, len(fns))
	for i, f := range fns {
		out[i] = toV1Fn(f)
	}
	return out, http.StatusOK, nil
}

func (h *handlers) v1Function(r *http.Request) (any, int, error) {
	resp, err := h.GetEdgeFunction(r.Context(), api.GetEdgeFunctionRequestObject{Ref: chi.URLParam(r, "ref"), Name: chi.URLParam(r, "slug")})
	if err != nil {
		return nil, 0, err
	}
	d, ok := resp.(api.GetEdgeFunction200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	return toV1Fn(d.Function), http.StatusOK, nil
}

func (h *handlers) v1DeleteFunction(r *http.Request) (any, int, error) {
	if _, err := h.DeleteEdgeFunction(r.Context(), api.DeleteEdgeFunctionRequestObject{Ref: chi.URLParam(r, "ref"), Name: chi.URLParam(r, "slug")}); err != nil {
		return nil, 0, err
	}
	return struct{}{}, http.StatusOK, nil
}

// --- Function secrets

type v1Secret struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func (h *handlers) v1Secrets(r *http.Request) (any, int, error) {
	resp, err := h.ListFunctionSecrets(r.Context(), api.ListFunctionSecretsRequestObject{Ref: chi.URLParam(r, "ref")})
	if err != nil {
		return nil, 0, err
	}
	secrets, ok := resp.(api.ListFunctionSecrets200JSONResponse)
	if !ok {
		return nil, 0, unexpected(resp)
	}
	// As Supabase does, values are their SHA-256 digests.
	out := make([]v1Secret, len(secrets))
	for i, s := range secrets {
		out[i] = v1Secret{Name: s.Name, Value: s.Digest}
	}
	return out, http.StatusOK, nil
}

func (h *handlers) v1SetSecrets(r *http.Request) (any, int, error) {
	var in []v1Secret
	if err := decode(r, &in); err != nil {
		return nil, 0, err
	}
	body := api.SetFunctionSecretsJSONRequestBody{}
	for _, s := range in {
		body.Secrets = append(body.Secrets, struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		}{s.Name, s.Value})
	}
	if _, err := h.SetFunctionSecrets(r.Context(), api.SetFunctionSecretsRequestObject{Ref: chi.URLParam(r, "ref"), Body: &body}); err != nil {
		return nil, 0, err
	}
	return struct{}{}, http.StatusCreated, nil
}

func (h *handlers) v1DeleteSecrets(r *http.Request) (any, int, error) {
	var names []string
	if err := decode(r, &names); err != nil {
		return nil, 0, err
	}
	if _, err := h.DeleteFunctionSecrets(r.Context(), api.DeleteFunctionSecretsRequestObject{Ref: chi.URLParam(r, "ref"), Body: &api.DeleteFunctionSecretsJSONRequestBody{Names: names}}); err != nil {
		return nil, 0, err
	}
	return struct{}{}, http.StatusOK, nil
}

// --- Pausing and restoring a stack Supermixer created

func (h *handlers) v1StackAction(action string) v1Route {
	return func(r *http.Request) (any, int, error) {
		if _, err := h.StackAction(r.Context(), api.StackActionRequestObject{Ref: chi.URLParam(r, "ref"), Action: action}); err != nil {
			return nil, 0, err
		}
		return struct{}{}, http.StatusOK, nil
	}
}
