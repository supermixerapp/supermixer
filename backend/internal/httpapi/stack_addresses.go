package httpapi

import (
	"context"
	"strings"

	"supermixer/internal/provision"
	"supermixer/internal/store/db"
)

// managedAddresses are a created stack's addresses as users reach them:
// its API (and Studio) URL, its Postgres host and sslmode.
func (h *handlers) managedAddresses(p db.Project, tls bool) (apiURL, dbHost, sslmode string) {
	pv := h.deps.Config.Provisioning
	return publicURL(pv, int(*p.StackApiPort), tls), strings.Trim(pv.PublicHost, "[]"), stackSSLMode(tls)
}

// syncManagedRows brings created stacks' rows into line with the
// configuration: their addresses follow provisioning.public_host and each
// stack's TLS setting. Rows from before kept connect_host, which is how
// Supermixer reaches the stacks, not how their users do.
func (h *handlers) syncManagedRows(ctx context.Context) {
	if !h.deps.Config.Provisioning.Enabled || h.deps.Store == nil {
		return
	}
	rows, err := h.deps.Store.Queries.ListManagedProjects(ctx)
	if err != nil {
		h.deps.Logger.ErrorContext(ctx, "listing stacks to update their addresses", "err", err)
		return
	}
	changed := 0
	for _, p := range rows {
		if ctx.Err() != nil {
			return
		}
		env, err := provision.ReadEnv(h.stackLayout(p.Ref).Dir)
		if err != nil {
			continue // its folder is gone (being deleted, or failed early)
		}
		if h.setManagedAddresses(ctx, p, provision.TLSOf(env)) {
			changed++
		}
	}
	if changed > 0 {
		h.deps.Logger.InfoContext(ctx, "updated stacks' addresses to match the configuration", "stacks", changed)
	}
}

// setManagedAddresses saves a stack's addresses if they've changed, and
// reports whether they had.
func (h *handlers) setManagedAddresses(ctx context.Context, p db.Project, tls bool) bool {
	apiURL, host, sslmode := h.managedAddresses(p, tls)
	if p.ApiUrl == apiURL && p.StudioUrl == apiURL && p.DbHost == host && p.DbSslmode == sslmode {
		return false
	}
	if _, err := h.deps.Store.Queries.SetManagedAddresses(ctx, db.SetManagedAddressesParams{
		ID: p.ID, ApiUrl: apiURL, StudioUrl: apiURL, DbHost: host, DbSslmode: sslmode,
	}); err != nil {
		h.deps.Logger.ErrorContext(ctx, "updating a stack's addresses", "project", p.Ref, "err", err)
		return false
	}
	h.pools.Forget(p.Ref)
	h.health.forget(p.Ref)
	h.hsts.forget()
	return true
}
