package httpapi

import (
	"context"
	"errors"
	"net/http"
	"sort"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
)

// Auth settings of stacks Supermixer created (Stage 4.3). They're the auth
// service's environment, so a change recreates that service.

func (h *handlers) authConfigOut(dir string) (api.AuthConfig, error) {
	cfg, err := provision.ReadAuthConfig(dir)
	if err != nil {
		return api.AuthConfig{}, err
	}
	return api.AuthConfig{Values: cfg.Values, SecretsSet: cfg.SecretsSet, CallbackUrl: provision.OAuthCallbackURL(dir)}, nil
}

func (h *handlers) GetAuthConfig(ctx context.Context, req api.GetAuthConfigRequestObject) (api.GetAuthConfigResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "view this project's Auth settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, newError(http.StatusConflict, "Supermixer connects to this stack, so its Auth settings are set where it runs")
	}
	out, err := h.authConfigOut(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, err
	}
	return api.GetAuthConfig200JSONResponse(out), nil
}

func (h *handlers) UpdateAuthConfig(ctx context.Context, req api.UpdateAuthConfigRequestObject) (api.UpdateAuthConfigResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "change this project's Auth settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, newError(http.StatusConflict, "Supermixer connects to this stack, so its Auth settings are set where it runs")
	}
	if req.Body == nil || len(*req.Body) == 0 {
		return nil, badRequest("no settings given")
	}
	changes := make([]provision.AuthChange, 0, len(*req.Body))
	for name, v := range *req.Body {
		changes = append(changes, provision.AuthChange{Name: name, Value: v})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Name < changes[j].Name })
	if err := provision.ValidateAuthChanges(changes); err != nil {
		return nil, badRequest("%s", err)
	}
	dir := h.stackLayout(p.Ref).Dir
	var changed []string
	// auth-templates serves custom email templates; stacks started before it
	// existed don't have it running yet.
	restarted, err := h.changeService(ctx, p, "updating Auth settings", "auth", []string{"auth-templates"}, func() error {
		if err := provision.PrepareStack(dir); err != nil { // stacks from before auth.env
			return err
		}
		var err error
		changed, err = provision.ApplyAuthChanges(dir, changes)
		var fieldErr provision.ErrAuthField
		if errors.As(err, &fieldErr) {
			return badRequest("%s", err)
		}
		return err
	})
	// Refused before anything was written (invalid, or the stack busy): nothing to audit.
	if err != nil && (isStatus(err, http.StatusBadRequest) || isStatus(err, http.StatusConflict)) {
		return nil, err
	}
	meta := map[string]any{"settings": changed}
	if changed == nil { // failed while writing: some files may have changed
		names := make([]string, len(changes))
		for i, c := range changes {
			names[i] = c.Name
		}
		meta = map[string]any{"settings": names, "error": firstLine(err.Error())}
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.auth_config_updated",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
	if err != nil {
		return nil, err // saved (perhaps partly), but not applied
	}
	out, err := h.authConfigOut(dir)
	if err != nil {
		return nil, err
	}
	out.Restarted = &restarted
	return api.UpdateAuthConfig200JSONResponse(out), nil
}
