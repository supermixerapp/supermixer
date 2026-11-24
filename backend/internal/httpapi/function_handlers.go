package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
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
	sum, err := provision.FunctionHash(dir, req.Name)
	if err != nil {
		return nil, err
	}
	out := api.GetEdgeFunction200JSONResponse{Function: h.toEdgeFunction(p, info), OtherFiles: other, Sha256: sum,
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
	by := username(ctx)
	var version provision.FunctionVersion
	var recordErr error
	restarted, err := h.changeFunctions(ctx, p, "deploying "+req.Name, func() error {
		h.beforeFunctionChange(ctx, p, dir, req.Name)
		if err := provision.WriteFunction(dir, req.Name, files, keep); err != nil {
			return badRequest("%s", err)
		}
		// From here the new files are live: a failure to keep the version
		// doesn't stop the restart or the audit entry.
		version, _, recordErr = provision.RecordFunctionVersion(dir, req.Name, provision.VersionDeployed, by, "", time.Now())
		return nil
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	meta := h.versionAudit(dir, req.Name, version, recordErr)
	meta["function"], meta["new"] = req.Name, missing != nil
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_deployed",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
	if err != nil {
		return nil, err // saved, but the restart failed
	}
	if recordErr != nil {
		return nil, newError(http.StatusInternalServerError, "deployed, but keeping this version failed: %v", recordErr)
	}
	out, err := h.functionChange(p, dir, req.Name, restarted, version)
	if err != nil {
		return nil, err
	}
	return api.DeployEdgeFunction200JSONResponse(out), nil
}

// functionChange is the response to a deploy or restore.
func (h *handlers) functionChange(p db.Project, dir, name string, restarted bool, v provision.FunctionVersion) (api.EdgeFunctionChange, error) {
	info, _, _, err := provision.ReadFunction(dir, name)
	if err != nil {
		return api.EdgeFunctionChange{}, err
	}
	fn := h.toEdgeFunction(p, info)
	out := api.EdgeFunctionChange{Function: &fn, Restarted: restarted}
	if v.ID != "" {
		av := toFunctionVersion(v)
		out.Version = &av
	}
	return out, nil
}

// beforeFunctionChange runs, holding the stack, before a function's files
// change: the function as it is is kept as a version (if it isn't already),
// so it can be restored, and the database is snapshotted for Advisors ›
// Changes. Neither stops the change if it fails.
func (h *handlers) beforeFunctionChange(ctx context.Context, p db.Project, dir, name string) {
	if err := provision.RecordFoundVersion(dir, name, time.Now()); err != nil {
		h.deps.Logger.Warn("keeping a function's current version", "ref", p.Ref, "function", name, "err", err)
	}
	h.snapshotBeforeDeploy(ctx, p, name)
}

// versionAudit is what the audit log records of a function version: the
// number of files, the function's hash and each file's, so a deploy can be
// checked against what ran. If the version couldn't be kept, the hash is
// taken from the files now.
func (h *handlers) versionAudit(dir, name string, v provision.FunctionVersion, recordErr error) map[string]any {
	if v.ID == "" {
		meta := map[string]any{}
		if recordErr != nil {
			meta["version_error"] = firstLine(recordErr.Error())
			if sum, err := provision.FunctionHash(dir, name); err == nil {
				meta["sha256"] = sum
			}
		}
		return meta
	}
	hashes := make([]map[string]any, len(v.Files))
	for i, f := range v.Files {
		hashes[i] = map[string]any{"path": f.Path, "sha256": f.SHA256}
	}
	return map[string]any{"version": v.ID, "sha256": v.SHA256, "files": len(v.Files), "file_hashes": hashes}
}

func toFunctionVersion(v provision.FunctionVersion) api.FunctionVersion {
	var out api.FunctionVersion
	b, _ := json.Marshal(v) // the same JSON shape
	_ = json.Unmarshal(b, &out)
	return out
}

// username is the signed-in user's name, for records.
func username(ctx context.Context) string {
	if p, err := currentUser(ctx); err == nil {
		return p.User.Username
	}
	return ""
}

func (h *handlers) ListFunctionVersions(ctx context.Context, req api.ListFunctionVersionsRequestObject) (api.ListFunctionVersionsResponseObject, error) {
	_, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectDataRead, "view this project's functions")
	if err != nil {
		return nil, err
	}
	list, err := provision.ListFunctionVersions(dir, req.Name)
	if errors.Is(err, provision.ErrNoFunction) {
		return nil, newError(http.StatusNotFound, "there's no function %q", req.Name)
	}
	if err != nil {
		return nil, err
	}
	out := make(api.ListFunctionVersions200JSONResponse, len(list))
	for i, v := range list {
		out[i] = toFunctionVersion(v)
	}
	return out, nil
}

func (h *handlers) GetFunctionVersion(ctx context.Context, req api.GetFunctionVersionRequestObject) (api.GetFunctionVersionResponseObject, error) {
	_, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectDataRead, "view this project's functions")
	if err != nil {
		return nil, err
	}
	v, files, other, err := provision.ReadFunctionVersion(dir, req.Name, req.Id)
	if errors.Is(err, provision.ErrNoVersion) {
		return nil, notFound("version")
	}
	if err != nil {
		return nil, err
	}
	out := api.GetFunctionVersion200JSONResponse{Version: toFunctionVersion(v), OtherFiles: other,
		Files: make([]api.EdgeFunctionFile, len(files))}
	for i, f := range files {
		out.Files[i] = api.EdgeFunctionFile{Path: f.Path, Content: f.Content}
	}
	return out, nil
}

func (h *handlers) RestoreFunctionVersion(ctx context.Context, req api.RestoreFunctionVersionRequestObject) (api.RestoreFunctionVersionResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectFunctionsDeploy, "deploy functions")
	if err != nil {
		return nil, err
	}
	if _, _, _, err := provision.ReadFunctionVersion(dir, req.Name, req.Id); err != nil {
		return nil, notFound("version")
	}
	by := username(ctx)
	var version provision.FunctionVersion
	var recordErr error
	restarted, err := h.changeFunctions(ctx, p, "restoring "+req.Name, func() error {
		h.beforeFunctionChange(ctx, p, dir, req.Name)
		if err := provision.RestoreFunctionVersion(dir, req.Name, req.Id); err != nil {
			return err
		}
		version, _, recordErr = provision.RecordFunctionVersion(dir, req.Name, provision.VersionRestored, by, req.Id, time.Now())
		return nil
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	meta := h.versionAudit(dir, req.Name, version, recordErr)
	meta["function"], meta["restored_from"] = req.Name, req.Id
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_restored",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
	if err != nil {
		return nil, err
	}
	if recordErr != nil {
		return nil, newError(http.StatusInternalServerError, "restored, but keeping this version failed: %v", recordErr)
	}
	out, err := h.functionChange(p, dir, req.Name, restarted, version)
	if err != nil {
		return nil, err
	}
	return api.RestoreFunctionVersion200JSONResponse(out), nil
}

func (h *handlers) DeleteEdgeFunction(ctx context.Context, req api.DeleteEdgeFunctionRequestObject) (api.DeleteEdgeFunctionResponseObject, error) {
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectFunctionsDeploy, "delete functions")
	if err != nil {
		return nil, err
	}
	var last provision.FunctionVersion
	restarted, err := h.changeFunctions(ctx, p, "deleting "+req.Name, func() error {
		// Kept, so a deleted function can be restored.
		if err := provision.RecordFoundVersion(dir, req.Name, time.Now()); err != nil {
			h.deps.Logger.Warn("keeping a function's current version", "ref", p.Ref, "function", req.Name, "err", err)
		}
		if list, err := provision.ListFunctionVersions(dir, req.Name); err == nil && len(list) > 0 {
			last = list[0]
		}
		err := provision.DeleteFunction(dir, req.Name)
		if errors.Is(err, provision.ErrNoFunction) {
			return newError(http.StatusNotFound, "there's no function %q", req.Name)
		}
		return err
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	meta := h.versionAudit(dir, req.Name, last, nil)
	meta["function"] = req.Name
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_deleted",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
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
		AdminAccess:    provision.FunctionsAdminAccessOf(env),
	}, nil
}

func (h *handlers) SetFunctionSettings(ctx context.Context, req api.SetFunctionSettingsRequestObject) (api.SetFunctionSettingsResponseObject, error) {
	// What functions can reach changes what every deployer's code can do,
	// so it takes project settings access, not deploy access.
	p, dir, err := h.managedFunctions(ctx, req.Ref, rbac.ProjectUpdate, "change what functions can reach")
	if err != nil {
		return nil, err
	}
	b := req.Body
	if b.DatabaseAccess == nil && b.AdminAccess == nil {
		return nil, badRequest("give database_access, admin_access or both")
	}
	if b.DatabaseAccess != nil {
		if a := provision.DBAccess(*b.DatabaseAccess); a != provision.DBAccessServiceRole && a != provision.DBAccessPostgres {
			return nil, badRequest("database_access is service_role or postgres")
		}
	}
	var before, after map[string]string
	restarted, err := h.changeFunctions(ctx, p, "changing what functions can reach", func() error {
		// Older stacks get the functions' database login settings first.
		if err := provision.PrepareEnv(dir); err != nil {
			return err
		}
		env, err := provision.ReadEnv(dir)
		if err != nil {
			return err
		}
		before = env
		values := map[string]string{}
		if b.DatabaseAccess != nil {
			values["FUNCTIONS_DB_LOGIN"] = provision.FunctionsDBLogin(provision.DBAccess(*b.DatabaseAccess), env)
		}
		if b.AdminAccess != nil {
			values["FUNCTIONS_ADMIN_ACCESS"] = strconv.FormatBool(*b.AdminAccess)
		}
		if err := provision.UpdateEnv(dir, values); err != nil {
			return err
		}
		// Rewrites the overlay, and the router's patch that admin access needs.
		if err := provision.RefreshOverlay(dir); err != nil {
			_ = provision.UpdateEnv(dir, map[string]string{
				"FUNCTIONS_DB_LOGIN": env["FUNCTIONS_DB_LOGIN"], "FUNCTIONS_ADMIN_ACCESS": env["FUNCTIONS_ADMIN_ACCESS"]})
			return conflict("%v", err)
		}
		after, err = provision.ReadEnv(dir)
		return err
	})
	if err != nil && !isStatus(err, http.StatusBadGateway) {
		return nil, err
	}
	meta := map[string]any{
		"database_access": string(provision.FunctionsDBAccessOf(after)), "was": string(provision.FunctionsDBAccessOf(before)),
		"admin_access": provision.FunctionsAdminAccessOf(after), "admin_access_was": provision.FunctionsAdminAccessOf(before),
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.function_settings_updated",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
	if err != nil {
		return nil, err
	}
	return api.SetFunctionSettings200JSONResponse{
		DatabaseAccess: api.SetFunctionSettings200JSONResponseBodyDatabaseAccess(provision.FunctionsDBAccessOf(after)),
		AdminAccess:    provision.FunctionsAdminAccessOf(after),
		Restarted:      restarted,
	}, nil
}
