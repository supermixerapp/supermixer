package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Log drains for stacks Supermixer created (Stage 4.5); see provision/drains.go.

func toDrain(d provision.LogDrain) api.LogDrain {
	out := api.LogDrain{
		Id: d.ID, Name: d.Name, Type: api.LogDrainType(d.Type), Enabled: d.Enabled, Url: d.URL, Gzip: d.Gzip,
		DatadogSite: d.DatadogSite, ApiKeySet: d.APIKey != "",
		Headers: make([]struct {
			Name     string `json:"name"`
			ValueSet bool   `json:"value_set"`
		}, len(d.Headers)),
	}
	for i, h := range d.Headers {
		out.Headers[i].Name, out.Headers[i].ValueSet = h.Name, h.Value != ""
	}
	return out
}

func (h *handlers) ListLogDrains(ctx context.Context, req api.ListLogDrainsRequestObject) (api.ListLogDrainsResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectRead, "view this project")
	if err != nil {
		return nil, err
	}
	drains, err := provision.ReadDrains(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, err
	}
	out := api.ListLogDrains200JSONResponse{Drains: make([]api.LogDrain, len(drains))}
	for i, d := range drains {
		out.Drains[i] = toDrain(d)
	}
	return out, nil
}

// fromInput applies a drain's new settings over its current ones (secrets
// left out are kept).
func fromInput(cur provision.LogDrain, in api.LogDrainInput) provision.LogDrain {
	d := cur
	d.Name, d.Type = strings.TrimSpace(in.Name), string(in.Type)
	d.Enabled = in.Enabled == nil || *in.Enabled
	d.URL, d.Gzip, d.DatadogSite = "", false, ""
	if in.Url != nil {
		d.URL = strings.TrimSpace(*in.Url)
	}
	if in.Gzip != nil {
		d.Gzip = *in.Gzip
	}
	if in.DatadogSite != nil {
		d.DatadogSite = *in.DatadogSite
	}
	if in.ApiKey != nil && *in.ApiKey != "" {
		d.APIKey = strings.TrimSpace(*in.ApiKey)
	}
	if d.Type != "datadog" {
		d.APIKey = ""
	}
	d.Headers = nil
	if in.Headers != nil && d.Type != "datadog" {
		for _, hd := range *in.Headers {
			v := ""
			if hd.Value != nil {
				v = *hd.Value
			} else {
				for _, old := range cur.Headers {
					if strings.EqualFold(old.Name, hd.Name) {
						v = old.Value
					}
				}
			}
			d.Headers = append(d.Headers, provision.Header{Name: strings.TrimSpace(hd.Name), Value: v})
		}
	}
	return d
}

// saveDrains checks the drains with Vector, saves them, and restarts Vector
// if the stack runs.
func (h *handlers) saveDrains(ctx context.Context, p db.Project, what string, drains []provision.LogDrain) error {
	l := h.stackLayout(p.Ref)
	_, err := h.changeService(ctx, p, what, "vector", nil, func() error {
		// Older stacks' overlay predates drains.
		if err := provision.RefreshOverlay(l.Dir); err != nil {
			return err
		}
		if err := provision.StageDrains(l.Dir, l.Project, drains); err != nil {
			return badRequest("%v", err)
		}
		if err := h.compose(p.Ref).ValidateDrains(ctx, nil); err != nil {
			provision.DiscardDrains(l.Dir)
			return badRequest("Vector refused the configuration: %s", firstLine(err.Error()))
		}
		return provision.CommitDrains(l.Dir, drains)
	})
	return err
}

func (h *handlers) drainAudit(ctx context.Context, p db.Project, action string, d provision.LogDrain) {
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: action,
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name,
		Metadata: map[string]any{"drain": d.Name, "type": d.Type}})
}

func (h *handlers) CreateLogDrain(ctx context.Context, req api.CreateLogDrainRequestObject) (api.CreateLogDrainResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectUpdate, "add log drains")
	if err != nil {
		return nil, err
	}
	drains, err := provision.ReadDrains(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, err
	}
	if len(drains) >= 10 {
		return nil, conflict("a project has 10 log drains at most")
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	d := fromInput(provision.LogDrain{ID: hex.EncodeToString(b)}, *req.Body)
	if err := provision.ValidateDrain(d); err != nil {
		return nil, badRequest("%v", err)
	}
	if err := h.saveDrains(ctx, p, "adding log drain "+d.Name, append(drains, d)); err != nil {
		return nil, err
	}
	h.drainAudit(ctx, p, "project.log_drain_created", d)
	return api.CreateLogDrain201JSONResponse(toDrain(d)), nil
}

func (h *handlers) UpdateLogDrain(ctx context.Context, req api.UpdateLogDrainRequestObject) (api.UpdateLogDrainResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectUpdate, "change log drains")
	if err != nil {
		return nil, err
	}
	drains, err := provision.ReadDrains(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, err
	}
	for i, cur := range drains {
		if cur.ID != req.Id {
			continue
		}
		d := fromInput(cur, *req.Body)
		if err := provision.ValidateDrain(d); err != nil {
			return nil, badRequest("%v", err)
		}
		drains[i] = d
		if err := h.saveDrains(ctx, p, "changing log drain "+d.Name, drains); err != nil {
			return nil, err
		}
		h.drainAudit(ctx, p, "project.log_drain_updated", d)
		return api.UpdateLogDrain200JSONResponse(toDrain(d)), nil
	}
	return nil, notFound("log drain")
}

func (h *handlers) DeleteLogDrain(ctx context.Context, req api.DeleteLogDrainRequestObject) (api.DeleteLogDrainResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectUpdate, "remove log drains")
	if err != nil {
		return nil, err
	}
	drains, err := provision.ReadDrains(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, err
	}
	for i, d := range drains {
		if d.ID == req.Id {
			if err := h.saveDrains(ctx, p, "removing log drain "+d.Name, append(drains[:i:i], drains[i+1:]...)); err != nil {
				return nil, err
			}
			h.drainAudit(ctx, p, "project.log_drain_deleted", d)
			return api.DeleteLogDrain204Response{}, nil
		}
	}
	return nil, notFound("log drain")
}
