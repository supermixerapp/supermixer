package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
)

// Storage › Settings and S3 Connection. Settings of stacks Supermixer
// created live in their .env (provision/storageconfig.go), so a change
// recreates the storage service; stacks it connects to set them where they
// run.

// errNothingToChange stops changeService before it recreates the service.
var errNothingToChange = errors.New("nothing to change")

const storageElsewhere = "Supermixer connects to this stack, so its Storage settings are set where it runs (FILE_SIZE_LIMIT and ENABLE_IMAGE_TRANSFORMATION on its storage service)"

func toStorageConfig(c provision.StorageConfig) api.StorageConfig {
	out := api.StorageConfig{FileSizeLimit: c.FileSizeLimit, ImageTransformation: c.ImageTransformation}
	if len(c.Problems) > 0 {
		problems := make([]api.StorageProblem, len(c.Problems))
		for i, p := range c.Problems {
			problems[i] = api.StorageProblem{Setting: api.StorageProblemSetting(p.Setting), Message: p.Message}
		}
		out.Problems = &problems
	}
	return out
}

func (h *handlers) GetStorageConfig(ctx context.Context, req api.GetStorageConfigRequestObject) (api.GetStorageConfigResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "view this project's Storage settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, newError(http.StatusConflict, storageElsewhere)
	}
	c, err := provision.ReadStorageConfig(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, err
	}
	return api.GetStorageConfig200JSONResponse(toStorageConfig(c)), nil
}

func (h *handlers) UpdateStorageConfig(ctx context.Context, req api.UpdateStorageConfigRequestObject) (api.UpdateStorageConfigResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "change this project's Storage settings")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, newError(http.StatusConflict, storageElsewhere)
	}
	change := provision.StorageChange{FileSizeLimit: req.Body.FileSizeLimit, ImageTransformation: req.Body.ImageTransformation}
	if err := provision.ValidateStorageChange(change); err != nil {
		return nil, badRequest("%s", err)
	}
	dir := h.stackLayout(p.Ref).Dir
	current, err := provision.ReadStorageConfig(dir)
	if err != nil {
		return nil, err
	}
	// Nothing to change: no restart (it would cut off uploads), nothing to
	// audit. Checked again under the stack's lock (another save may have
	// made the same change meanwhile).
	unchanged := func() (api.UpdateStorageConfigResponseObject, error) {
		c, err := provision.ReadStorageConfig(dir)
		if err != nil {
			return nil, err
		}
		out := toStorageConfig(c)
		out.Restarted = new(bool)
		return api.UpdateStorageConfig200JSONResponse(out), nil
	}
	if len(provision.StorageDiff(current, change)) == 0 {
		return unchanged()
	}
	var changed []string
	saved := false
	restarted, err := h.changeService(ctx, p, "updating Storage settings", "storage", nil, func() error {
		// Stacks from before these settings get the overlay that reads them.
		if err := provision.PrepareStack(dir); err != nil {
			return err
		}
		var err error
		changed, err = provision.ApplyStorageChange(dir, change)
		if err == nil && len(changed) == 0 {
			return errNothingToChange // not recreated
		}
		saved = err == nil
		return err
	})
	if errors.Is(err, errNothingToChange) {
		return unchanged()
	}
	// Refused, or failed before .env was written (an atomic rename): nothing changed.
	if !saved {
		return nil, err
	}
	meta := map[string]any{"settings": changed}
	if err != nil {
		meta["error"] = firstLine(err.Error())
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.storage_config_updated",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: meta})
	if err != nil {
		return nil, err // saved, but not applied
	}
	c, err := provision.ReadStorageConfig(dir)
	if err != nil {
		return nil, err
	}
	out := toStorageConfig(c)
	out.Restarted = &restarted
	return api.UpdateStorageConfig200JSONResponse(out), nil
}

func (h *handlers) GetStorageS3(ctx context.Context, req api.GetStorageS3RequestObject) (api.GetStorageS3ResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectRead, "view this project's S3 connection")
	if err != nil {
		return nil, err
	}
	reveal := deref(req.Params.Reveal)
	if reveal && !rbac.ProjectCan(a.Role, rbac.ProjectSecretsRead) {
		return nil, forbidden("view the S3 secret access key")
	}
	p := a.Project()
	out := api.StorageS3{Endpoint: strings.TrimRight(p.ApiUrl, "/") + "/storage/v1/s3"}
	if h.stackOf(p) == nil {
		return api.GetStorageS3200JSONResponse(out), nil
	}
	c, err := provision.ReadStorageConfig(h.stackLayout(p.Ref).Dir)
	if err != nil {
		return nil, err
	}
	out.Managed = true
	out.Region, out.AccessKeyId = &c.Region, &c.S3AccessKeyID
	if reveal {
		out.SecretAccessKey = &c.S3AccessKeySecret
		h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.secrets_revealed",
			TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"secret": "s3_keys"}})
	}
	return api.GetStorageS3200JSONResponse(out), nil
}
