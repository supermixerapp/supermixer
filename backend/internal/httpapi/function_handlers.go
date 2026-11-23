package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Edge Functions of stacks Supermixer created (Stage 4.2): their files live
// in the stack's volumes/functions folder, their secrets in functions.env.
// Changes take effect when the functions service is recreated, which
// happens at once if the stack is running.

const functionsRestartTimeout = 3 * time.Minute

// managedFunctions loads a project whose stack Supermixer created.
func (h *handlers) managedFunctions(ctx context.Context, ref string, perm rbac.Permission, action string) (db.Project, string, error) {
	a, err := h.loadProject(ctx, ref, perm, action)
	if err != nil {
		return db.Project{}, "", err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return db.Project{}, "", newError(http.StatusConflict,
			"Supermixer connects to this stack, so it can't reach its functions folder; deploy with the Supabase CLI where it runs")
	}
	return p, h.stackLayout(p.Ref).Dir, nil
}

// changeFunctions changes Edge Functions; see changeService.
func (h *handlers) changeFunctions(ctx context.Context, p db.Project, what string, change func() error) (bool, error) {
	return h.changeService(ctx, p, what, "functions", nil, change)
}

// changeService runs change, then recreates service if the stack is
// running, as one operation on the stack (so it can't overlap a start, pause
// or delete). Services in ensure are started first if they aren't running
// (ones a newer overlay added). It reports whether service was recreated.
func (h *handlers) changeService(ctx context.Context, p db.Project, what, service string, ensure []string, change func() error) (bool, error) {
	if !h.deps.Config.Provisioning.Enabled {
		return false, errProvisioningOff()
	}
	if !h.stacks.begin(p.Ref, api.StackOperationUpdating) {
		return false, conflict("the stack is busy with another operation; wait for it to finish")
	}
	defer h.stacks.end(p.Ref)
	// Read again now that no other operation can change it: a start or pause
	// may have finished since the request loaded the project.
	row, err := h.deps.Store.Queries.GetProjectByRef(ctx, p.Ref)
	if err != nil {
		return false, err
	}
	status := row.Project.StackStatus.StackStatus
	switch status {
	case db.StackStatusProvisioning, db.StackStatusDeleting:
		return false, conflict("the stack is being created or deleted; wait for it to finish")
	}
	if err := change(); err != nil {
		return false, err
	}
	if status != db.StackStatusRunning {
		return false, nil // takes effect when the stack starts
	}
	log := &stackLog{dir: h.stackLayout(p.Ref).Dir}
	defer log.Close()
	fmt.Fprintf(log, "\n== %s: %s; recreating %s ==\n", time.Now().UTC().Format(time.RFC3339), what, service)
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), functionsRestartTimeout)
	defer cancel()
	for _, s := range ensure {
		if err := h.compose(p.Ref).Ensure(rctx, log, s); err != nil {
			fmt.Fprintf(log, "\nstarting %s failed: %v\n", s, err)
			return false, newError(http.StatusBadGateway,
				"saved, but the %s service didn't start: %v (see Settings › Infrastructure › Output)", s, firstLine(err.Error()))
		}
	}
	if err := h.compose(p.Ref).Recreate(rctx, log, service); err != nil {
		fmt.Fprintf(log, "\nrecreating %s failed: %v\n", service, err)
		return false, newError(http.StatusBadGateway,
			"saved, but the %s service didn't restart: %v (see Settings › Infrastructure › Output)", service, firstLine(err.Error()))
	}
	fmt.Fprintf(log, "\n%s recreated\n", service)
	return true, nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

func (h *handlers) toEdgeFunction(p db.Project, f provision.FunctionInfo) api.EdgeFunction {
	out := api.EdgeFunction{
		Name: f.Name, Url: strings.TrimRight(p.ApiUrl, "/") + "/functions/v1/" + f.Name,
		UpdatedAt: f.Updated, Files: f.Files, Size: int(f.Size),
	}
	if f.Entrypoint != "" {
		out.Entrypoint = ptr(f.Entrypoint)
	}
	return out
}

func (h *handlers) ListEdgeFunctions(ctx context.Context, req api.ListEdgeFunctionsRequestObject) (api.ListEdgeFunctionsResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectDataRead, "view this project's functions")
	if err != nil {
		return nil, err
	}
	fns, err := provision.ListFunctions(dir)
	if err != nil {
		return nil, err
	}
	out := make(api.ListEdgeFunctions200JSONResponse, len(fns))
	for i, f := range fns {
		out[i] = h.toEdgeFunction(p, f)
	}
	return out, nil
}

func (h *handlers) GetEdgeFunction(ctx context.Context, req api.GetEdgeFunctionRequestObject) (api.GetEdgeFunctionResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectDataRead, "view this project's functions")
	if err != nil {
		return nil, err
	}
	info, files, other, err := provision.ReadFunction(dir, req.Name)
	if errors.Is(err, provision.ErrNoFunction) {
		return nil, newError(http.StatusNotFound, "there's no function %q", req.Name)
	}
	if err != nil {
		return nil, err
	}
	out := api.GetEdgeFunction200JSONResponse{Function: h.toEdgeFunction(p, info), OtherFiles: other,
		Files: make([]api.EdgeFunctionFile, len(files))}
	for i, f := range files {
		out.Files[i] = api.EdgeFunctionFile{Path: f.Path, Content: f.Content}
	}
	return out, nil
}

func (h *handlers) DeployEdgeFunction(ctx context.Context, req api.DeployEdgeFunctionRequestObject) (api.DeployEdgeFunctionResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectFunctionsDeploy, "deploy functions")
	if err != nil {
		return nil, err
	}
	if err := provision.ValidFunctionName(req.Name); err != nil {
		return nil, badRequest("%s", err)
	}
	files := make([]provision.FunctionFile, len(req.Body.Files))
	for i, f := range req.Body.Files {
		files[i] = provision.FunctionFile{Path: f.Path, Content: f.Content}
	}
	keep := deref(req.Body.Keep)
	_, _, _, missing := provision.ReadFunction(dir, req.Name)
	restarted, err := h.changeFunctions(ctx, p, "deploying "+req.Name, func() error {
		if err := provision.WriteFunction(dir, req.Name, files, keep); err != nil {
			return badRequest("%s", err)
		}
		return nil
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_deployed",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name,
		Metadata: map[string]any{"function": req.Name, "files": len(files) + len(keep), "new": missing != nil}})
	if err != nil {
		return nil, err // saved, but the restart failed
	}
	info, _, _, err := provision.ReadFunction(dir, req.Name)
	if err != nil {
		return nil, err
	}
	fn := h.toEdgeFunction(p, info)
	return api.DeployEdgeFunction200JSONResponse{Function: &fn, Restarted: restarted}, nil
}

func (h *handlers) DeleteEdgeFunction(ctx context.Context, req api.DeleteEdgeFunctionRequestObject) (api.DeleteEdgeFunctionResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectFunctionsDeploy, "delete functions")
	if err != nil {
		return nil, err
	}
	restarted, err := h.changeFunctions(ctx, p, "deleting "+req.Name, func() error {
		err := provision.DeleteFunction(dir, req.Name)
		if errors.Is(err, provision.ErrNoFunction) {
			return newError(http.StatusNotFound, "there's no function %q", req.Name)
		}
		return err
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_deleted",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"function": req.Name}})
	if err != nil {
		return nil, err
	}
	return api.DeleteEdgeFunction200JSONResponse{Restarted: restarted}, nil
}

// ---------------------------------------------------------------- secrets

func secretList(secrets map[string]string) []api.FunctionSecret {
	out := make([]api.FunctionSecret, 0, len(secrets))
	for k, v := range secrets {
		out = append(out, api.FunctionSecret{Name: k, Digest: provision.SecretDigest(v)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (h *handlers) ListFunctionSecrets(ctx context.Context, req api.ListFunctionSecretsRequestObject) (api.ListFunctionSecretsResponseObject, error) {
	_, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectSecretsRead, "view function secrets")
	if err != nil {
		return nil, err
	}
	secrets, err := provision.ReadFunctionSecrets(dir)
	if err != nil {
		return nil, err
	}
	return api.ListFunctionSecrets200JSONResponse(secretList(secrets)), nil
}

func (h *handlers) SetFunctionSecrets(ctx context.Context, req api.SetFunctionSecretsRequestObject) (api.SetFunctionSecretsResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectFunctionsDeploy, "change function secrets")
	if err != nil {
		return nil, err
	}
	if len(req.Body.Secrets) == 0 {
		return nil, badRequest("no secrets given")
	}
	names := make([]string, 0, len(req.Body.Secrets))
	seen := map[string]bool{}
	for _, s := range req.Body.Secrets {
		if err := provision.ValidSecretName(s.Name); err != nil {
			return nil, badRequest("%s", err)
		}
		if seen[s.Name] {
			return nil, badRequest("%s is given twice", s.Name)
		}
		seen[s.Name] = true
		if err := provision.ValidSecretValue(s.Name, s.Value); err != nil {
			return nil, badRequest("%s", err)
		}
		names = append(names, s.Name)
	}
	var secrets map[string]string
	restarted, err := h.changeFunctions(ctx, p, "updating function secrets", func() error {
		var err error
		if secrets, err = provision.ReadFunctionSecrets(dir); err != nil {
			return err
		}
		for _, s := range req.Body.Secrets {
			secrets[s.Name] = s.Value
		}
		if len(secrets) > provision.MaxSecrets {
			return badRequest("a stack has at most %d function secrets", provision.MaxSecrets)
		}
		if err := provision.RefreshOverlay(dir); err != nil {
			return err
		}
		return provision.WriteFunctionSecrets(dir, secrets)
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	sort.Strings(names)
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_secrets_set",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"names": names}})
	if err != nil {
		return nil, err
	}
	return api.SetFunctionSecrets200JSONResponse{Secrets: secretList(secrets), Restarted: restarted}, nil
}

func (h *handlers) DeleteFunctionSecrets(ctx context.Context, req api.DeleteFunctionSecretsRequestObject) (api.DeleteFunctionSecretsResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectFunctionsDeploy, "change function secrets")
	if err != nil {
		return nil, err
	}
	if len(req.Body.Names) == 0 {
		return nil, badRequest("no secrets given")
	}
	var secrets map[string]string
	var removed []string
	restarted, err := h.changeFunctions(ctx, p, "removing function secrets", func() error {
		var err error
		if secrets, err = provision.ReadFunctionSecrets(dir); err != nil {
			return err
		}
		for _, n := range req.Body.Names {
			if _, ok := secrets[n]; ok {
				delete(secrets, n)
				removed = append(removed, n)
			}
		}
		if len(removed) == 0 {
			return newError(http.StatusNotFound, "there are no secrets of those names")
		}
		return provision.WriteFunctionSecrets(dir, secrets)
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	sort.Strings(removed)
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_secrets_deleted",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"names": removed}})
	if err != nil {
		return nil, err
	}
	return api.DeleteFunctionSecrets200JSONResponse{Secrets: secretList(secrets), Restarted: restarted}, nil
}

// isStatus reports whether err is an API error with that HTTP status.
func isStatus(err error, status int) bool {
	var e *apiError
	return errors.As(err, &e) && e.status == status
}

// ---------------------------------------------------------------- settings

func (h *handlers) GetFunctionSettings(ctx context.Context, req api.GetFunctionSettingsRequestObject) (api.GetFunctionSettingsResponseObject, error) {
	_, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectRead, "view this project's functions")
	if err != nil {
		return nil, err
	}
	env, err := provision.ReadEnv(dir)
	if err != nil {
		return nil, err
	}
	return api.GetFunctionSettings200JSONResponse{
		DatabaseAccess: api.FunctionSettingsDatabaseAccess(provision.FunctionsDBAccessOf(env)),
	}, nil
}

func (h *handlers) SetFunctionSettings(ctx context.Context, req api.SetFunctionSettingsRequestObject) (api.SetFunctionSettingsResponseObject, error) {
	// Giving functions the postgres login widens what every deployer's code
	// can do, so it takes project settings access, not deploy access.
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectUpdate, "change how functions reach the database")
	if err != nil {
		return nil, err
	}
	access := provision.DBAccess(req.Body.DatabaseAccess)
	if access != provision.DBAccessServiceRole && access != provision.DBAccessPostgres {
		return nil, badRequest("database_access is service_role or postgres")
	}
	var before provision.DBAccess
	restarted, err := h.changeFunctions(ctx, p, "changing the functions' database access to "+string(access), func() error {
		if err := provision.PrepareStack(dir); err != nil {
			return err
		}
		env, err := provision.ReadEnv(dir)
		if err != nil {
			return err
		}
		before = provision.FunctionsDBAccessOf(env)
		return provision.UpdateEnv(dir, map[string]string{"FUNCTIONS_DB_LOGIN": provision.FunctionsDBLogin(access, env)})
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_settings_updated",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name,
		Metadata: map[string]any{"database_access": string(access), "was": string(before)}})
	if err != nil {
		return nil, err
	}
	return api.SetFunctionSettings200JSONResponse{
		DatabaseAccess: api.SetFunctionSettings200JSONResponseBodyDatabaseAccess(access), Restarted: restarted,
	}, nil
}
