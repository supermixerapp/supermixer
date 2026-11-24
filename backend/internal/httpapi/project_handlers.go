package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/naming"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/stack"
	"supermixer/internal/store/db"
)

// healthCache avoids re-probing a stack on every page load.
type healthCache struct {
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]healthEntry
}

type healthEntry struct {
	report stack.Report
	at     time.Time
}

func (c *healthCache) get(ref string) (stack.Report, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[ref]
	if !ok || time.Since(e.at) > c.ttl {
		return stack.Report{}, false
	}
	return e.report, true
}

func (c *healthCache) put(ref string, r stack.Report) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]healthEntry{}
	}
	c.entries[ref] = healthEntry{report: r, at: time.Now()}
}

func (c *healthCache) forget(ref string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, ref)
}

func validProjectName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || len([]rune(s)) > 64 {
		return "", badRequest("project name must be 1–64 characters")
	}
	return s, nil
}

// buildConnection validates connection input. With existing set (an
// update), empty secrets keep their current values.
func buildConnection(in api.ProjectConnection, existing *stack.Connection) (stack.Connection, string, error) {
	var c stack.Connection
	var err error
	if c.APIURL, err = stack.NormalizeAPIURL(in.ApiUrl); err != nil {
		return c, "", badRequest("API URL: %s", err.Error())
	}
	studio := ""
	if s := strings.TrimSpace(deref(in.StudioUrl)); s != "" {
		if studio, err = stack.NormalizeAPIURL(s); err != nil {
			return c, "", badRequest("Studio URL: %s", err.Error())
		}
	}
	d := in.Database
	c.Database = stack.Database{
		Host: strings.TrimSpace(d.Host), Port: d.Port, Name: strings.TrimSpace(d.Name),
		User: strings.TrimSpace(d.User), Password: deref(d.Password), SSLMode: string(d.Sslmode),
	}
	if c.Database.Host == "" || c.Database.Name == "" || c.Database.User == "" {
		return c, "", badRequest("database host, name and user are required")
	}
	if c.Database.Port < 1 || c.Database.Port > 65535 {
		return c, "", badRequest("database port must be between 1 and 65535")
	}
	if !slices.Contains(stack.SSLModes, c.Database.SSLMode) {
		return c, "", badRequest("unknown SSL mode %q", c.Database.SSLMode)
	}
	k := in.Keys
	c.Keys = stack.Keys{
		Anon: strings.TrimSpace(deref(k.Anon)), ServiceRole: strings.TrimSpace(deref(k.ServiceRole)),
		Publishable: strings.TrimSpace(deref(k.Publishable)), Secret: strings.TrimSpace(deref(k.Secret)),
		JWTSecret: strings.TrimSpace(deref(k.JwtSecret)),
	}
	if existing != nil {
		keep := func(v *string, old string) {
			if *v == "" {
				*v = old
			}
		}
		keep(&c.Keys.Anon, existing.Keys.Anon)
		keep(&c.Keys.ServiceRole, existing.Keys.ServiceRole)
		keep(&c.Keys.Publishable, existing.Keys.Publishable)
		keep(&c.Keys.Secret, existing.Keys.Secret)
		keep(&c.Keys.JWTSecret, existing.Keys.JWTSecret)
		keep(&c.Database.Password, existing.Database.Password)
		// The read-only login lives in the same database; keep it while the
		// connection still points there.
		same := existing.Database
		if c.Database.Host == same.Host && c.Database.Port == same.Port && c.Database.Name == same.Name {
			c.ReadOnly = existing.ReadOnly
		}
	}
	if c.Database.Password == "" {
		return c, "", badRequest("database password is required")
	}
	if err := c.Keys.Validate(); err != nil {
		return c, "", badRequest("%s", err.Error())
	}
	return c, studio, nil
}

// sealedSecrets is what gets encrypted into projects.secrets.
type sealedSecrets struct {
	Keys       stack.Keys   `json:"keys"`
	DBPassword string       `json:"db_password"`
	ReadOnly   *stack.Login `json:"read_only,omitempty"`
}

func (h *handlers) seal(ref string, c stack.Connection) ([]byte, error) {
	return h.deps.Box.SealJSON(sealedSecrets{Keys: c.Keys, DBPassword: c.Database.Password, ReadOnly: c.ReadOnly}, []byte(ref))
}

// connection decrypts a project's stored connection.
func (h *handlers) connection(p db.Project) (stack.Connection, error) {
	var s sealedSecrets
	if err := h.deps.Box.OpenJSON(p.Secrets, []byte(p.Ref), &s); err != nil {
		return stack.Connection{}, err
	}
	return stack.Connection{
		APIURL: p.ApiUrl,
		Database: stack.Database{
			Host: p.DbHost, Port: int(p.DbPort), Name: p.DbName, User: p.DbUser, Password: s.DBPassword, SSLMode: p.DbSslmode,
		},
		Keys:     s.Keys,
		ReadOnly: s.ReadOnly,
	}, nil
}

func (h *handlers) toProject(p db.Project, orgSlug, orgName string, role rbac.Role) (api.Project, error) {
	conn, err := h.connection(p)
	if err != nil {
		return api.Project{}, err
	}
	out := api.Project{
		Id: p.ID, Ref: p.Ref, Name: p.Name, OrganizationSlug: orgSlug, OrganizationName: orgName,
		ApiUrl: p.ApiUrl, StudioUrl: p.StudioUrl, Role: api.OrgRole(role),
		Permissions: permStrings(rbac.ProjectPermissions(role)), CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
	out.Database.Host, out.Database.Port, out.Database.Name = p.DbHost, int(p.DbPort), p.DbName
	out.Database.User, out.Database.Sslmode = p.DbUser, p.DbSslmode
	out.Database.Uri = conn.Database.URI(false)
	if conn.ReadOnly != nil {
		out.Database.ReadOnlyUser = &conn.ReadOnly.User
	}
	k := conn.Keys
	out.KeysPresent.Anon, out.KeysPresent.ServiceRole = k.Anon != "", k.ServiceRole != ""
	out.KeysPresent.Publishable, out.KeysPresent.Secret, out.KeysPresent.JwtSecret = k.Publishable != "", k.Secret != "", k.JWTSecret != ""
	out.Stack = h.stackOf(p)
	return out, nil
}

func (h *handlers) ListProjects(ctx context.Context, req api.ListProjectsRequestObject) (api.ListProjectsResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	_, projects, err := h.visibleProjects(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListProjects200JSONResponse, 0, len(projects))
	for _, vp := range projects {
		if req.Params.OrganizationSlug != nil && vp.Row.OrganizationSlug != *req.Params.OrganizationSlug {
			continue
		}
		proj, err := h.toProject(vp.Row.Project, vp.Row.OrganizationSlug, vp.Row.OrganizationName, vp.Role)
		if err != nil {
			return nil, err
		}
		out = append(out, proj)
	}
	return out, nil
}

func (h *handlers) TestConnection(ctx context.Context, req api.TestConnectionRequestObject) (api.TestConnectionResponseObject, error) {
	if _, err := h.loadOrg(ctx, req.Slug, rbac.ProjectsCreate, "add projects"); err != nil {
		return nil, err
	}
	conn, _, err := buildConnection(*req.Body, nil)
	if err != nil {
		return nil, err
	}
	out := toHealthReport(h.checker.Check(ctx, conn))
	if found := provision.ExampleSecrets(conn.Keys.JWTSecret, conn.Keys.Anon, conn.Keys.ServiceRole, conn.Database.Password); len(found) > 0 {
		out.ExampleSecrets = &found
	}
	return api.TestConnection200JSONResponse(out), nil
}

func (h *handlers) CreateProject(ctx context.Context, req api.CreateProjectRequestObject) (api.CreateProjectResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.ProjectsCreate, "add projects")
	if err != nil {
		return nil, err
	}
	name, err := validProjectName(req.Body.Name)
	if err != nil {
		return nil, err
	}
	conn, studio, err := buildConnection(req.Body.Connection, nil)
	if err != nil {
		return nil, err
	}
	var project db.Project
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		var ref string
		for {
			if ref, err = naming.ProjectRef(); err != nil {
				return err
			}
			exists, err := q.ProjectRefExists(ctx, ref)
			if err != nil {
				return err
			}
			if !exists {
				break
			}
		}
		secrets, err := h.seal(ref, conn)
		if err != nil {
			return err
		}
		if err := checkProjectLimit(ctx, q, a.Org.ID, a.Org.Name); err != nil {
			return err
		}
		project, err = q.CreateProject(ctx, db.CreateProjectParams{
			Ref: ref, OrganizationID: a.Org.ID, Name: name, ApiUrl: conn.APIURL, StudioUrl: studio,
			DbHost: conn.Database.Host, DbPort: int32(conn.Database.Port), DbName: conn.Database.Name,
			DbUser: conn.Database.User, DbSslmode: conn.Database.SSLMode, Secrets: secrets, CreatedBy: &a.User.User.ID,
		})
		if err != nil {
			return err
		}
		h.audit(ctx, q, auditEntry{OrgID: &a.Org.ID, ProjectID: &project.ID, Action: "project.created", TargetType: "project",
			TargetID: project.Ref, TargetName: project.Name, Metadata: map[string]any{"api_url": project.ApiUrl}})
		return nil
	})
	if err != nil {
		return nil, err
	}
	out, err := h.toProject(project, a.Org.Slug, a.Org.Name, rbac.EffectiveProjectRole(a.Role, nil))
	if err != nil {
		return nil, err
	}
	return api.CreateProject201JSONResponse(out), nil
}

func (h *handlers) GetProject(ctx context.Context, req api.GetProjectRequestObject) (api.GetProjectResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "view this project")
	if err != nil {
		return nil, err
	}
	out, err := h.toProject(a.Project(), a.Row.OrganizationSlug, a.Row.OrganizationName, a.Role)
	if err != nil {
		return nil, err
	}
	return api.GetProject200JSONResponse(out), nil
}

func (h *handlers) UpdateProject(ctx context.Context, req api.UpdateProjectRequestObject) (api.UpdateProjectResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "change project settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	current, err := h.connection(p)
	if err != nil {
		return nil, err
	}
	changed := []string{}
	if req.Body.Name != nil {
		name, err := validProjectName(*req.Body.Name)
		if err != nil {
			return nil, err
		}
		if name != p.Name {
			changed = append(changed, "name")
		}
		p.Name = name
	}
	if req.Body.Connection != nil && p.Managed {
		return nil, conflict("Supermixer created this project's stack and keeps its connection details; they can't be edited")
	}
	if req.Body.Connection != nil {
		conn, studio, err := buildConnection(*req.Body.Connection, &current)
		if err != nil {
			return nil, err
		}
		if p.Secrets, err = h.seal(p.Ref, conn); err != nil {
			return nil, err
		}
		p.ApiUrl, p.StudioUrl = conn.APIURL, studio
		p.DbHost, p.DbPort, p.DbName = conn.Database.Host, int32(conn.Database.Port), conn.Database.Name
		p.DbUser, p.DbSslmode = conn.Database.User, conn.Database.SSLMode
		changed = append(changed, "connection")
	}
	updated, err := h.deps.Store.Queries.UpdateProject(ctx, db.UpdateProjectParams{
		ID: p.ID, Name: p.Name, ApiUrl: p.ApiUrl, StudioUrl: p.StudioUrl, DbHost: p.DbHost, DbPort: p.DbPort,
		DbName: p.DbName, DbUser: p.DbUser, DbSslmode: p.DbSslmode, Secrets: p.Secrets,
	})
	if err != nil {
		return nil, err
	}
	h.health.forget(p.Ref)
	h.pools.Forget(p.Ref)
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.updated", TargetType: "project",
		TargetID: p.Ref, TargetName: updated.Name, Metadata: map[string]any{"changed": changed}})
	out, err := h.toProject(updated, a.Row.OrganizationSlug, a.Row.OrganizationName, a.Role)
	if err != nil {
		return nil, err
	}
	return api.UpdateProject200JSONResponse(out), nil
}

func (h *handlers) TransferProject(ctx context.Context, req api.TransferProjectRequestObject) (api.TransferProjectResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "")
	if err != nil {
		return nil, err
	}
	if !rbac.OrgCan(a.OrgRole, rbac.ProjectsTransfer) {
		return nil, forbidden("transfer projects out of this organization")
	}
	target, err := h.loadOrg(ctx, req.Body.OrganizationSlug, rbac.ProjectsTransfer, "transfer projects into that organization")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if target.Org.ID == p.OrganizationID {
		return nil, badRequest("the project is already in %s", target.Org.Name)
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		// Members of the old organization who could read the keys and won't
		// in the new one keep what they read: its admins are told to rotate.
		members, err := q.ListMembers(ctx, p.OrganizationID)
		if err != nil {
			return err
		}
		could := map[uuid.UUID]bool{}
		for _, m := range members {
			if m.User.DisabledAt != nil {
				continue // advised when it was disabled
			}
			access, err := keyAccess(ctx, q, p.OrganizationID, m.User.ID)
			if err != nil {
				return err
			}
			could[m.User.ID] = access[p.ID]
		}
		if err := checkProjectLimit(ctx, q, target.Org.ID, target.Org.Name); err != nil {
			return err
		}
		if err := q.MoveProject(ctx, db.MoveProjectParams{ID: p.ID, OrganizationID: target.Org.ID}); err != nil {
			return err
		}
		// Project-scoped roles belonged to members of the old organization.
		if err := q.DeleteProjectRoles(ctx, p.ID); err != nil {
			return err
		}
		for _, m := range members {
			if !could[m.User.ID] {
				continue
			}
			access, err := keyAccess(ctx, q, target.Org.ID, m.User.ID)
			if err != nil {
				return err
			}
			if !access[p.ID] {
				if err := q.AddRotationAdvisory(ctx, db.AddRotationAdvisoryParams{ProjectID: p.ID, Username: m.User.Username, Reason: "transferred"}); err != nil {
					return err
				}
			}
		}
		meta := map[string]any{"from": a.Row.OrganizationSlug, "to": target.Org.Slug}
		h.audit(ctx, q, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.transferred_out", TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
		h.audit(ctx, q, auditEntry{OrgID: &target.Org.ID, ProjectID: &p.ID, Action: "project.transferred_in", TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
		return nil
	})
	if err != nil {
		return nil, err
	}
	p.OrganizationID = target.Org.ID
	out, err := h.toProject(p, target.Org.Slug, target.Org.Name, rbac.EffectiveProjectRole(target.Role, nil))
	if err != nil {
		return nil, err
	}
	return api.TransferProject200JSONResponse(out), nil
}

func (h *handlers) DeleteProject(ctx context.Context, req api.DeleteProjectRequestObject) (api.DeleteProjectResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectDelete, "remove this project")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if p.Managed {
		// Supermixer created the stack, so it removes it too (in the background).
		if err := h.deleteManaged(ctx, p); err != nil {
			return nil, err
		}
		return api.DeleteProject204Response{}, nil
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		h.audit(ctx, q, auditEntry{OrgID: &p.OrganizationID, Action: "project.deleted", TargetType: "project", TargetID: p.Ref, TargetName: p.Name})
		return q.DeleteProject(ctx, p.ID)
	})
	if err != nil {
		return nil, err
	}
	h.health.forget(p.Ref)
	h.pools.Forget(p.Ref)
	return api.DeleteProject204Response{}, nil
}

func toHealthReport(r stack.Report) api.HealthReport {
	out := api.HealthReport{Status: api.HealthReportStatus(r.Status), CheckedAt: r.CheckedAt}
	if r.PostgresVersion != "" {
		out.PostgresVersion = &r.PostgresVersion
	}
	if r.AuthVersion != "" {
		out.AuthVersion = &r.AuthVersion
	}
	out.Services = make([]api.ServiceCheck, 0, len(r.Services))
	for _, s := range r.Services {
		sc := api.ServiceCheck{
			Service: api.ServiceCheckService(s.Service), Label: s.Label,
			Status: api.ServiceCheckStatus(s.Status), LatencyMs: s.LatencyMS,
		}
		if s.Detail != "" {
			sc.Detail = ptr(s.Detail)
		}
		out.Services = append(out.Services, sc)
	}
	return out
}

func (h *handlers) GetProjectHealth(ctx context.Context, req api.GetProjectHealthRequestObject) (api.GetProjectHealthResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "view this project")
	if err != nil {
		return nil, err
	}
	if r, ok := h.health.get(req.Ref); ok {
		return api.GetProjectHealth200JSONResponse(toHealthReport(r)), nil
	}
	conn, err := h.connection(a.Project())
	if err != nil {
		return nil, err
	}
	// Not cancelled with the request: a page navigating away mid-check would
	// otherwise cache a report of "context canceled" failures for everyone
	// (each probe has its own timeout).
	r := h.checker.Check(context.WithoutCancel(ctx), conn)
	h.health.put(req.Ref, r)
	return api.GetProjectHealth200JSONResponse(toHealthReport(r)), nil
}

func (h *handlers) ListApiKeys(ctx context.Context, req api.ListApiKeysRequestObject) (api.ListApiKeysResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "view this project")
	if err != nil {
		return nil, err
	}
	reveal := deref(req.Params.Reveal)
	if reveal && !rbac.ProjectCan(a.Role, rbac.ProjectSecretsRead) {
		return nil, forbidden("view secret API keys")
	}
	p := a.Project()
	conn, err := h.connection(p)
	if err != nil {
		return nil, err
	}
	k := conn.Keys
	type key struct {
		id, name, desc string
		kind           api.ApiKeyKind
		secret         bool
		value          string
	}
	keys := []key{
		{"publishable", "Publishable key", "Safe to use in a browser if Row Level Security is enabled on your tables.", api.ApiKeyKindApiKey, false, k.Publishable},
		{"secret", "Secret key", "Bypasses Row Level Security. Only use on a server; never expose it.", api.ApiKeyKindApiKey, true, k.Secret},
		{"anon", "anon", "Legacy public key. Safe in a browser if Row Level Security is enabled.", api.ApiKeyKindLegacy, false, k.Anon},
		{"service_role", "service_role", "Legacy secret key. Bypasses Row Level Security; never expose it.", api.ApiKeyKindLegacy, true, k.ServiceRole},
		{"jwt_secret", "JWT secret", "Signs the legacy JWT-based API keys and user sessions.", api.ApiKeyKindJwtSecret, true, k.JWTSecret},
	}
	out := make(api.ListApiKeys200JSONResponse, 0, len(keys))
	for _, kk := range keys {
		item := api.ApiKey{
			Id: api.ApiKeyId(kk.id), Name: kk.name, Kind: kk.kind, Secret: kk.secret,
			Present: kk.value != "", Description: kk.desc,
		}
		if kk.value != "" && (!kk.secret || reveal) {
			item.Value = ptr(kk.value)
		}
		out = append(out, item)
	}
	if reveal {
		h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.secrets_revealed",
			TargetType: "project", TargetID: p.Ref, TargetName: p.Name})
	}
	return out, nil
}

// ------------------------------------------------------------------ audit

func (h *handlers) ListAuditLogs(ctx context.Context, req api.ListAuditLogsRequestObject) (api.ListAuditLogsResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.AuditRead, "view audit logs")
	if err != nil {
		return nil, err
	}
	limit := 50
	if req.Params.Limit != nil {
		limit = min(max(*req.Params.Limit, 1), 200)
	}
	params := db.ListAuditLogsParams{
		OrganizationID: &a.Org.ID, Since: req.Params.Since, BeforeID: req.Params.Before,
		RowLimit: int32(limit + 1),
	}
	if s := strings.TrimSpace(deref(req.Params.Action)); s != "" {
		params.ActionPrefix = &s
	}
	if req.Params.ActorId != nil {
		id := *req.Params.ActorId
		params.ActorID = &id
	}
	rows, err := h.deps.Store.Queries.ListAuditLogs(ctx, params)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return api.ListAuditLogs200JSONResponse(toAuditPage(rows, limit)), nil
}

// toAuditPage is a page of entries; rows holds up to one more than limit,
// which says there's a next page.
func toAuditPage(rows []db.AuditLog, limit int) api.AuditLogPage {
	page := api.AuditLogPage{Entries: []api.AuditLogEntry{}}
	if len(rows) > limit {
		rows = rows[:limit]
		page.NextBefore = ptr(rows[len(rows)-1].ID)
	}
	for _, r := range rows {
		e := api.AuditLogEntry{
			Id: r.ID, Action: r.Action, ActorId: r.ActorID, ActorUsername: r.ActorUsername,
			TargetType: r.TargetType, TargetId: r.TargetID, TargetName: r.TargetName,
			Ip: r.Ip, CreatedAt: r.CreatedAt, Metadata: map[string]any{},
		}
		_ = json.Unmarshal(r.Metadata, &e.Metadata)
		if r.TargetType == "project" {
			e.ProjectRef = ptr(r.TargetID)
		}
		page.Entries = append(page.Entries, e)
	}
	return page
}
