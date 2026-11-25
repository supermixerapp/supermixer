package httpapi

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/store/db"
)

// applyStudio makes the running stacks Supermixer created run Supabase
// Studio or not, as provisioning.studio says, when this instance takes on
// the background work (Supermixer starting). One stack at a time, and only
// Studio's container is started or removed: the projects stay up. It goes
// by what Docker reports as well as the stack's .env, so a change that
// failed before is tried again. Stacks that aren't running, or are busy,
// follow the setting when they're next started (bringUp).
func (h *handlers) applyStudio(ctx context.Context) {
	pv := h.deps.Config.Provisioning
	if !pv.Enabled {
		return
	}
	if !pv.Studio {
		if err := h.checkCompose(ctx); err != nil {
			h.deps.Logger.ErrorContext(ctx, "studio: can't leave Supabase Studio out of stacks", "err", err)
			return
		}
	}
	rows, err := h.deps.Store.Queries.ListStacksWithStatus(ctx, db.ListStacksWithStatusParams{
		Statuses: []string{string(db.StackStatusRunning)}, Before: time.Now(),
	})
	if err != nil {
		h.deps.Logger.ErrorContext(ctx, "studio: listing the stacks", "err", err)
		return
	}
	for _, p := range rows {
		if ctx.Err() != nil {
			return
		}
		if !h.studioNeedsChange(ctx, p.Ref, pv.Studio) {
			continue
		}
		if !h.stacks.begin(p.Ref, api.StackOperationUpdating) {
			continue
		}
		err := h.setStudio(ctx, p.Ref, pv.Studio)
		h.stacks.end(p.Ref)
		if err != nil {
			h.deps.Logger.WarnContext(ctx, "studio: applying provisioning.studio", "project", p.Ref, "studio", pv.Studio, "err", err)
			continue
		}
		h.deps.Logger.InfoContext(ctx, "studio: applied provisioning.studio", "project", p.Ref, "studio", pv.Studio)
	}
}

// studioNeedsChange reports whether a stack's files or its Studio container
// don't match on. If Docker can't be asked, the files decide.
func (h *handlers) studioNeedsChange(ctx context.Context, ref string, on bool) bool {
	env, err := provision.ReadEnv(h.stackLayout(ref).Dir)
	if err != nil {
		h.deps.Logger.WarnContext(ctx, "studio: reading the stack's settings", "project", ref, "err", err)
		return false
	}
	// Stacks from before the setting have no entry, and ran Studio.
	if v, ok := env[provision.StudioEnv]; !ok || v != strconv.FormatBool(on) {
		return true
	}
	pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	services, err := h.compose(ref).PS(pctx)
	if err != nil {
		return false
	}
	exists, running := provision.StudioRunning(services)
	if on {
		return !running
	}
	return exists
}

// setStudio runs SetStudio within the start timeout, logging to the stack's
// log like other operations.
func (h *handlers) setStudio(ctx context.Context, ref string, on bool) error {
	ctx, cancel := context.WithTimeout(ctx, h.deps.Config.Provisioning.StartTimeout)
	defer cancel()
	log := &stackLog{dir: h.stackLayout(ref).Dir}
	defer log.Close()
	action := "Removing Supabase Studio (provisioning.studio is off)"
	if on {
		action = "Starting Supabase Studio (provisioning.studio is on)"
	}
	fmt.Fprintf(log, "\n== %s: %s ==\n", time.Now().UTC().Format(time.RFC3339), action)
	return h.compose(ref).SetStudio(ctx, log, on)
}
