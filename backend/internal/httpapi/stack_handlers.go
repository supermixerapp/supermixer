package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/config"
	"supermixer/internal/naming"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/stack"
	"supermixer/internal/store/db"
)

// Stacks Supermixer created itself (Stage 4): one background operation per
// stack at a time, its docker compose output appended to supermixer.log in the stack's
// folder, and its status saved when the operation ends.

const stackLogName = "supermixer.log"

type stackJobs struct {
	mu  sync.Mutex
	ops map[string]api.StackOperation // ref → what's running
	wg  sync.WaitGroup
}

func (j *stackJobs) begin(ref string, op api.StackOperation) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.ops == nil {
		j.ops = map[string]api.StackOperation{}
	}
	if _, busy := j.ops[ref]; busy {
		return false
	}
	j.ops[ref] = op
	j.wg.Add(1)
	return true
}

func (j *stackJobs) end(ref string) {
	j.mu.Lock()
	delete(j.ops, ref)
	j.mu.Unlock()
	j.wg.Done()
}

func (j *stackJobs) current(ref string) *api.StackOperation {
	j.mu.Lock()
	defer j.mu.Unlock()
	if op, ok := j.ops[ref]; ok {
		return &op
	}
	return nil
}

// Wait blocks until running operations end (tests, shutdown).
func (j *stackJobs) Wait() { j.wg.Wait() }

func (h *handlers) stackLayout(ref string) provision.Layout {
	return provision.Layout{Dir: filepath.Join(h.deps.Config.Provisioning.StacksDir, ref), Project: "supermixer-" + ref}
}

func (h *handlers) compose(ref string) provision.Compose {
	return provision.Compose{Docker: h.deps.Config.Provisioning.Docker, Layout: h.stackLayout(ref)}
}

func errProvisioningOff() error {
	return newError(http.StatusConflict, "this Supermixer server doesn't create stacks: set provisioning.enabled in its configuration")
}

// stackOf is a project's stack summary, nil for connected projects.
func (h *handlers) stackOf(p db.Project) *api.Stack {
	if !p.Managed || !p.StackStatus.Valid {
		return nil
	}
	return &api.Stack{
		Status: api.StackStatus(p.StackStatus.StackStatus), Error: p.StackError, StatusAt: p.StackStatusAt,
		Template: p.StackTemplate, Operation: h.stacks.current(p.Ref),
	}
}

func (h *handlers) CreateStack(ctx context.Context, req api.CreateStackRequestObject) (api.CreateStackResponseObject, error) {
	pv := h.deps.Config.Provisioning
	if !pv.Enabled {
		return nil, errProvisioningOff()
	}
	a, err := h.loadOrg(ctx, req.Slug, rbac.ProjectsCreate, "add projects")
	if err != nil {
		return nil, err
	}
	name, err := validProjectName(req.Body.Name)
	if err != nil {
		return nil, err
	}
	ports, err := h.allocatePorts(ctx, pv)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	secrets, err := provision.GenerateSecrets(now)
	if err != nil {
		return nil, err
	}
	apiKeys, err := provision.GenerateAPIKeys(secrets.JWTSecret, now)
	if err != nil {
		return nil, err
	}

	var project db.Project
	var layout provision.Layout
	written := false
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		ref, err := uniqueRef(ctx, q)
		if err != nil {
			return err
		}
		conn := managedConnection(pv, ref, ports, secrets, apiKeys)
		sealed, err := h.seal(ref, conn)
		if err != nil {
			return err
		}
		created, err := q.CreateProject(ctx, db.CreateProjectParams{
			Ref: ref, OrganizationID: a.Org.ID, Name: name, ApiUrl: conn.APIURL, StudioUrl: publicURL(pv, ports.API),
			DbHost: conn.Database.Host, DbPort: int32(conn.Database.Port), DbName: conn.Database.Name,
			DbUser: conn.Database.User, DbSslmode: conn.Database.SSLMode, Secrets: sealed, CreatedBy: &a.User.User.ID,
		})
		if err != nil {
			return err
		}
		project, err = q.SetProjectStack(ctx, db.SetProjectStackParams{
			ID: created.ID, StackStatus: db.NullStackStatus{StackStatus: db.StackStatusProvisioning, Valid: true},
			StackTemplate: provision.TemplateVersion(),
			StackApiPort:  i32(ports.API), StackDbPort: i32(ports.DB), StackPoolerPort: i32(ports.Pooler),
		})
		if err != nil {
			return err
		}
		h.audit(ctx, q, auditEntry{OrgID: &a.Org.ID, ProjectID: &project.ID, Action: "project.created", TargetType: "project",
			TargetID: project.Ref, TargetName: project.Name,
			Metadata: map[string]any{"api_url": project.ApiUrl, "managed": true, "template": project.StackTemplate}})

		// The files are written before the row is committed, so a stack
		// never exists without them ("Try again" only needs compose up).
		env := secrets.Env()
		for k, v := range apiKeys.Env() {
			env[k] = v
		}
		for k, v := range stackEnv(pv, ref, ports) {
			env[k] = v
		}
		layout = h.stackLayout(ref)
		if err := provision.WriteStack(layout, env); err != nil {
			return newError(http.StatusInternalServerError, "writing the stack's files: %v", err)
		}
		written = true
		return nil
	})
	if err != nil && written {
		_ = os.RemoveAll(layout.Dir) // nothing has run from it yet
	}
	if isUniqueViolation(err) {
		return nil, conflict("another stack took one of those ports at the same moment; try again")
	}
	if err != nil {
		return nil, err
	}

	h.runStack(ctx, project, api.StackOperationStarting, db.StackStatusRunning, h.compose(project.Ref).Up)

	out, err := h.toProject(project, a.Org.Slug, a.Org.Name, rbac.EffectiveProjectRole(a.Role, nil))
	if err != nil {
		return nil, err
	}
	return api.CreateStack202JSONResponse(out), nil
}

func uniqueRef(ctx context.Context, q *db.Queries) (string, error) {
	for {
		ref, err := naming.ProjectRef()
		if err != nil {
			return "", err
		}
		exists, err := q.ProjectRefExists(ctx, ref)
		if err != nil {
			return "", err
		}
		if !exists {
			return ref, nil
		}
	}
}

func i32(n int) *int32 {
	v := int32(n)
	return &v
}

func publicURL(pv config.Provisioning, port int) string {
	return "http://" + hostPort(pv.PublicHost, port)
}

func hostPort(host string, port int) string {
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]" // IPv6
	}
	return host + ":" + strconv.Itoa(port)
}

// stackEnv is the .env settings Supermixer chooses for a stack, on top of
// its generated secrets.
func stackEnv(pv config.Provisioning, ref string, p provision.Ports) map[string]string {
	public := publicURL(pv, p.API)
	return map[string]string{
		"API_GW_HTTP_PORT":              strconv.Itoa(p.API),
		"KONG_HTTP_PORT":                strconv.Itoa(p.API),
		"POSTGRES_PORT":                 strconv.Itoa(p.DB),
		"POOLER_PROXY_PORT_TRANSACTION": strconv.Itoa(p.Pooler),
		"POOLER_TENANT_ID":              ref,
		"SUPABASE_PUBLIC_URL":           public,
		"API_EXTERNAL_URL":              public + "/auth/v1",
	}
}

// managedConnection is how Supermixer reaches a stack it created.
func managedConnection(pv config.Provisioning, ref string, p provision.Ports, s provision.Secrets, k provision.APIKeys) stack.Connection {
	host := pv.StackHost()
	return stack.Connection{
		APIURL: "http://" + hostPort(host, p.API),
		Database: stack.Database{
			Host: host, Port: p.DB, Name: "postgres", User: "postgres." + ref, Password: s.PostgresPassword, SSLMode: "disable",
		},
		Keys: stack.Keys{
			Anon: s.AnonKey, ServiceRole: s.ServiceRoleKey, JWTSecret: s.JWTSecret,
			Publishable: k.Publishable, Secret: k.Secret,
		},
	}
}

// allocatePorts picks free ports: not held by another stack in the database,
// not published by any running container, and (best effort) not listened on.
func (h *handlers) allocatePorts(ctx context.Context, pv config.Provisioning) (provision.Ports, error) {
	ranges := make([]provision.PortRange, 3)
	for i, raw := range []string{pv.APIPorts, pv.DBPorts, pv.PoolerPorts} {
		r, err := config.ParsePortRange(raw)
		if err != nil {
			return provision.Ports{}, err
		}
		ranges[i] = provision.PortRange{First: r.First, Last: r.Last}
	}
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	taken, err := provision.PublishedPorts(dctx, pv.Docker)
	if err != nil {
		return provision.Ports{}, newError(http.StatusBadGateway, "can't reach Docker: %v", err)
	}
	rows, err := h.deps.Store.Queries.ListStackPorts(ctx)
	if err != nil {
		return provision.Ports{}, err
	}
	for _, r := range rows {
		for _, p := range []*int32{r.StackApiPort, r.StackDbPort, r.StackPoolerPort} {
			if p != nil {
				taken[int(*p)] = true
			}
		}
	}
	ports, err := provision.AllocatePorts(ranges[0], ranges[1], ranges[2], taken, provision.ListenFree)
	if errors.Is(err, provision.ErrNoPorts) {
		return provision.Ports{}, newError(http.StatusConflict, "%v; widen the provisioning port ranges", err)
	}
	return ports, err
}

// While an operation runs it touches the stack's status time every
// stackHeartbeat; a provisioning or deleting stack untouched for stackStale
// was cut short (its server stopped), and is marked failed.
const (
	stackHeartbeat = 30 * time.Second
	stackStale     = 3 * time.Minute
)

// runStack runs fn in the background as op, then saves the stack's status:
// ok on success, failed (with the error) otherwise. The job keeps reqCtx's
// values (who asked, from where, for audit entries) but not its deadline.
func (h *handlers) runStack(reqCtx context.Context, p db.Project, op api.StackOperation, ok db.StackStatus, fn func(ctx context.Context, log io.Writer) error) bool {
	if !h.stacks.begin(p.Ref, op) {
		return false
	}
	go func() {
		defer h.stacks.end(p.Ref)
		pv := h.deps.Config.Provisioning
		ctx, cancel := context.WithTimeout(context.WithoutCancel(reqCtx), pv.StartTimeout)
		defer cancel()
		go func() {
			t := time.NewTicker(stackHeartbeat)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					_ = h.deps.Store.Queries.TouchStack(ctx, p.ID)
				}
			}
		}()
		log := &stackLog{dir: h.stackLayout(p.Ref).Dir}
		defer log.Close()
		fmt.Fprintf(log, "\n== %s: %s ==\n", time.Now().UTC().Format(time.RFC3339), op)
		err := fn(ctx, log)
		status, msg := ok, ""
		if err != nil {
			status, msg = db.StackStatusFailed, err.Error()
			fmt.Fprintf(log, "\n%s failed: %v\n", op, err)
			h.deps.Logger.Warn("stack operation failed", "ref", p.Ref, "operation", op, "err", err)
		} else {
			fmt.Fprintf(log, "\n%s done\n", op)
		}
		cancel() // stops the heartbeat
		h.health.forget(p.Ref)
		if op == api.StackOperationDeleting && err == nil {
			return // the project row is gone
		}
		if _, err := h.deps.Store.Queries.SetStackStatus(context.Background(), db.SetStackStatusParams{
			ID: p.ID, StackStatus: db.NullStackStatus{StackStatus: status, Valid: true}, StackError: msg,
		}); err != nil {
			h.deps.Logger.Error("saving stack status", "ref", p.Ref, "err", err)
		}
	}()
	return true
}

// stackLog appends to the stack's supermixer.log once its folder exists.
type stackLog struct {
	dir string
	f   *os.File
}

func (l *stackLog) Write(p []byte) (int, error) {
	if l.f == nil {
		if _, err := os.Stat(l.dir); err != nil {
			return len(p), nil // not written yet (or already removed)
		}
		f, err := os.OpenFile(filepath.Join(l.dir, stackLogName), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return len(p), nil
		}
		l.f = f
	}
	return l.f.Write(p)
}

func (l *stackLog) Close() {
	if l.f != nil {
		_ = l.f.Close()
	}
}

// watchStacks recovers stacks at startup and then every minute until ctx ends.
func (h *handlers) watchStacks(ctx context.Context) {
	h.recoverStacks(ctx, time.Now().Add(-stackStale))
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.recoverStacks(ctx, time.Now().Add(-stackStale))
		}
	}
}

// recoverStacks fails operations that stopped without finishing: creating or
// deleting stacks whose status hasn't been touched since before (a running
// operation, on this server or another, touches it every stackHeartbeat).
// They can then be started (or deleted) again.
func (h *handlers) recoverStacks(ctx context.Context, before time.Time) {
	rows, err := h.deps.Store.Queries.ListStacksWithStatus(ctx, db.ListStacksWithStatusParams{
		Statuses: []string{string(db.StackStatusProvisioning), string(db.StackStatusDeleting)}, Before: before,
	})
	if err != nil {
		h.deps.Logger.Error("checking interrupted stacks", "err", err)
		return
	}
	for _, p := range rows {
		if h.stacks.current(p.Ref) != nil {
			continue // ours, and still running
		}
		msg := "Supermixer stopped while the stack was being created; start it again, or delete it"
		if p.StackStatus.StackStatus == db.StackStatusDeleting {
			msg = "Supermixer stopped while the stack was being deleted; delete it again"
		}
		if _, err := h.deps.Store.Queries.SetStackStatus(ctx, db.SetStackStatusParams{
			ID: p.ID, StackStatus: db.NullStackStatus{StackStatus: db.StackStatusFailed, Valid: true}, StackError: msg,
		}); err != nil {
			h.deps.Logger.Error("marking an interrupted stack failed", "ref", p.Ref, "err", err)
		}
	}
}

func (h *handlers) GetStack(ctx context.Context, req api.GetStackRequestObject) (api.GetStackResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "view this project")
	if err != nil {
		return nil, err
	}
	out, err := h.stackDetail(ctx, a.Project())
	if err != nil {
		return nil, err
	}
	return api.GetStack200JSONResponse(out), nil
}

func (h *handlers) stackDetail(ctx context.Context, p db.Project) (api.StackDetail, error) {
	s := h.stackOf(p)
	if s == nil {
		return api.StackDetail{}, newError(http.StatusNotFound, "this project is a stack Supermixer connects to, not one it created")
	}
	out := api.StackDetail{Status: s.Status, Error: s.Error, StatusAt: s.StatusAt, Template: s.Template}
	if s.Operation != nil {
		op := api.StackDetailOperation(*s.Operation)
		out.Operation = &op
	}
	if p.StackApiPort != nil && p.StackDbPort != nil && p.StackPoolerPort != nil {
		out.Ports.Api, out.Ports.Db, out.Ports.Pooler = int(*p.StackApiPort), int(*p.StackDbPort), int(*p.StackPoolerPort)
	}
	out.Log = tailFile(filepath.Join(h.stackLayout(p.Ref).Dir, stackLogName), 200)

	if !h.deps.Config.Provisioning.Enabled {
		msg := "provisioning is off on this server, so Supermixer doesn't ask Docker about the stack"
		out.ServicesError = &msg
		return out, nil
	}
	pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	services, err := h.compose(p.Ref).PS(pctx)
	if err != nil {
		msg := err.Error()
		out.ServicesError = &msg
		return out, nil
	}
	list := make([]struct {
		Health  string `json:"health"`
		Service string `json:"service"`
		State   string `json:"state"`
		Status  string `json:"status"`
	}, len(services))
	for i, sv := range services {
		list[i].Service, list[i].State, list[i].Health, list[i].Status = sv.Service, sv.State, sv.Health, sv.Status
	}
	out.Services = &list
	return out, nil
}

// tailFile returns about the last n lines of a file (empty if it's missing).
func tailFile(path string, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	const max = 64 * 1024
	info, err := f.Stat()
	if err != nil {
		return ""
	}
	start := info.Size() - max
	if start < 0 {
		start = 0
	}
	b := make([]byte, info.Size()-start)
	if _, err := f.ReadAt(b, start); err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if start > 0 && len(lines) > 0 {
		lines = lines[1:] // probably cut mid-line
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func (h *handlers) StackAction(ctx context.Context, req api.StackActionRequestObject) (api.StackActionResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "start or stop this project's stack")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, newError(http.StatusNotFound, "this project is a stack Supermixer connects to, not one it created")
	}
	if !h.deps.Config.Provisioning.Enabled {
		return nil, errProvisioningOff()
	}
	status := p.StackStatus.StackStatus
	if status == db.StackStatusDeleting {
		return nil, conflict("the stack is being deleted")
	}
	if _, err := os.Stat(h.stackLayout(p.Ref).Dir); err != nil {
		return nil, newError(http.StatusConflict, "the stack's folder %s is missing", h.stackLayout(p.Ref).Dir)
	}
	c := h.compose(p.Ref)
	var started bool
	var action string
	switch req.Action {
	case "start":
		action = "project.stack_started"
		started = h.runStack(ctx, p, api.StackOperationStarting, db.StackStatusRunning, c.Up)
	case "stop":
		action = "project.stack_stopped"
		started = h.runStack(ctx, p, api.StackOperationStopping, db.StackStatusPaused, c.Stop)
	case "restart":
		action = "project.stack_restarted"
		started = h.runStack(ctx, p, api.StackOperationRestarting, db.StackStatusRunning, c.Restart)
	default:
		return nil, badRequest("unknown action")
	}
	if !started {
		return nil, conflict("the stack is busy with another operation; wait for it to finish")
	}
	h.audit(ctx, h.deps.Store.Queries, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: action,
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name})
	out, err := h.stackDetail(ctx, p)
	if err != nil {
		return nil, err
	}
	return api.StackAction202JSONResponse(out), nil
}

// deleteManaged tears a created stack down, then removes the project.
func (h *handlers) deleteManaged(ctx context.Context, p db.Project) error {
	if !h.deps.Config.Provisioning.Enabled {
		return newError(http.StatusConflict, "turn provisioning on to delete this project: Supermixer created its stack and removes it with the project")
	}
	if h.stacks.current(p.Ref) != nil {
		return conflict("the stack is busy with another operation; wait for it to finish")
	}
	// Saved first: the operation may finish (and remove the row) at once.
	if _, err := h.deps.Store.Queries.SetStackStatus(ctx, db.SetStackStatusParams{
		ID: p.ID, StackStatus: db.NullStackStatus{StackStatus: db.StackStatusDeleting, Valid: true},
	}); err != nil {
		return err
	}
	layout := h.stackLayout(p.Ref)
	c := h.compose(p.Ref)
	started := h.runStack(ctx, p, api.StackOperationDeleting, db.StackStatusFailed, func(ctx context.Context, log io.Writer) error {
		if _, err := os.Stat(layout.Dir); err == nil {
			if err := c.Down(ctx, log); err != nil {
				return err
			}
			if err := provision.RemoveStackDir(ctx, h.deps.Config.Provisioning.Docker, layout.Dir, log); err != nil {
				return err
			}
		}
		return h.deps.Store.InTx(ctx, func(q *db.Queries) error {
			h.audit(ctx, q, auditEntry{OrgID: &p.OrganizationID, Action: "project.deleted", TargetType: "project",
				TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"managed": true}})
			return q.DeleteProject(ctx, p.ID)
		})
	})
	if !started {
		// Another operation slipped in; put the status back.
		_, _ = h.deps.Store.Queries.SetStackStatus(ctx, db.SetStackStatusParams{ID: p.ID, StackStatus: p.StackStatus, StackError: p.StackError})
		return conflict("the stack is busy with another operation; wait for it to finish")
	}
	h.pools.Forget(p.Ref)
	return nil
}

func (h *handlers) RevealStudioLogin(ctx context.Context, req api.RevealStudioLoginRequestObject) (api.RevealStudioLoginResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectSecretsRead, "view this stack's Studio login")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, newError(http.StatusNotFound, "this project is a stack Supermixer connects to; its Studio login is set where it runs")
	}
	env, err := provision.ReadEnv(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, newError(http.StatusConflict, "can't read the stack's settings: %v", err)
	}
	if env["DASHBOARD_USERNAME"] == "" || env["DASHBOARD_PASSWORD"] == "" {
		return nil, newError(http.StatusConflict, "the stack's .env has no Studio login")
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.secrets_revealed",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"secret": "studio_login"}})
	return api.RevealStudioLogin200JSONResponse{Username: env["DASHBOARD_USERNAME"], Password: env["DASHBOARD_PASSWORD"]}, nil
}
