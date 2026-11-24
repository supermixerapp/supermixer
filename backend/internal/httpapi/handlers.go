package httpapi

import (
	"context"
	"sync"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/mail"
	"supermixer/internal/provision"
	"supermixer/internal/stack"
	"supermixer/internal/version"
)

// handlers implements api.StrictServerInterface.
type handlers struct {
	deps    Deps
	csrf    *auth.CSRF
	limiter *auth.Limiter
	checker *stack.Checker
	health  *healthCache
	pools   *stack.Pools
	stacks  *stackJobs
	// s3 is the bucket backups are copied to, nil without one.
	s3      provision.ObjectStore
	uploads *uploader
	// mailer sends email; nil while it's off.
	mailer mail.Sender
	// inviteMail and resetMail limit the emails people can have sent to
	// others: invitations per inviter, reset links per account.
	inviteMail, resetMail *auth.Limiter
	// pending is work in the background that shutting down waits for.
	pending *sync.WaitGroup
}

var _ api.StrictServerInterface = (*handlers)(nil)

func (h *handlers) GetHealth(ctx context.Context, _ api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	out := api.Health{Status: api.HealthStatusHealthy, Version: version.Version}
	out.Database.Status = api.HealthDatabaseStatusHealthy

	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	// The endpoint is unauthenticated, so the detailed error only goes to the log.
	fail := func(err error) (api.GetHealthResponseObject, error) {
		h.deps.Logger.WarnContext(ctx, "health check: database unavailable", "err", err)
		msg := "database unavailable"
		out.Status = api.HealthStatusUnhealthy
		out.Database.Status = api.HealthDatabaseStatusUnhealthy
		out.Database.Error = &msg
		return api.GetHealth503JSONResponse(out), nil
	}

	if err := h.deps.DB.Ping(ctx); err != nil {
		return fail(err)
	}
	v, err := h.deps.DB.SchemaVersion(ctx)
	if err != nil {
		return fail(err)
	}
	out.Database.SchemaVersion = &v
	installed, err := h.deps.DB.InstalledAt(ctx)
	if err != nil {
		return fail(err)
	}
	out.Database.InstalledAt = &installed

	return api.GetHealth200JSONResponse(out), nil
}

func (h *handlers) GetUiConfig(_ context.Context, _ api.GetUiConfigRequestObject) (api.GetUiConfigResponseObject, error) {
	return api.GetUiConfig200JSONResponse{
		AppName:      "Supermixer",
		Version:      version.Version,
		BrandColor:   h.deps.Palette.Brand.Hex(),
		DefaultTheme: api.UiConfigDefaultTheme(h.deps.Config.Appearance.DefaultTheme),
		Provisioning: struct {
			Enabled  bool   `json:"enabled"`
			Template string `json:"template"`
		}{Enabled: h.deps.Config.Provisioning.Enabled, Template: provision.TemplateVersion()},
		EmailEnabled: h.mailer != nil,
	}, nil
}
