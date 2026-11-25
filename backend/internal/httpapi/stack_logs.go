package httpapi

import (
	"context"
	"fmt"
	"io"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// logsOff reports whether p is a stack Supermixer created that doesn't
// collect logs (no Logflare or Vector).
func (h *handlers) logsOff(p db.Project) bool {
	if !p.Managed {
		return false
	}
	_, logs := h.stackFeatures(p.Ref)
	return !logs
}

func errLogsOff() error {
	return conflict("this project's logs are off: turn them on under Settings › Infrastructure first")
}

// SetStackLogs turns a stack's logs on or off: Logflare and Vector, from
// docker-compose.logs.yml. A running stack is brought up on its new files
// in the background, which adds or removes the two containers (and
// recreates only services whose settings change); otherwise the files
// change, for its next start.
func (h *handlers) SetStackLogs(ctx context.Context, req api.SetStackLogsRequestObject) (api.SetStackLogsResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectUpdate, "turn this project's logs on or off")
	if err != nil {
		return nil, err
	}
	if !h.deps.Config.Provisioning.Enabled {
		return nil, errProvisioningOff()
	}
	on := req.Body.Enabled
	if _, logs := h.stackFeatures(p.Ref); logs != on {
		if !h.stacks.begin(p.Ref, api.StackOperationUpdating) {
			return nil, conflict("the stack is busy with another operation; wait for it to finish")
		}
		// Read again now that no other operation can change it: a start or
		// pause may have finished since the request loaded the project.
		row, err := h.deps.Store.Queries.GetProjectByRef(ctx, p.Ref)
		if err != nil {
			h.stacks.end(p.Ref)
			return nil, err
		}
		p = row.Project
		audit := func(ctx context.Context) {
			h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.logs_updated",
				TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"enabled": on}})
		}
		switch p.StackStatus.StackStatus {
		case db.StackStatusRunning:
			// Recorded once it's done: a change that fails is undone.
			h.runStackHeld(ctx, p, api.StackOperationUpdating, db.StackStatusRunning, h.deps.Config.Provisioning.StartTimeout,
				func(ctx context.Context, log io.Writer) error {
					if err := h.switchLogs(ctx, p.Ref, on, log); err != nil {
						return err
					}
					audit(ctx)
					return nil
				})
		case db.StackStatusPaused, db.StackStatusFailed:
			err := provision.SetLogs(h.stackLayout(p.Ref).Dir, on)
			h.stacks.end(p.Ref)
			if err != nil {
				return nil, fmt.Errorf("updating the stack's files: %w", err)
			}
			audit(ctx)
		default:
			h.stacks.end(p.Ref)
			return nil, conflict("the stack is being created or deleted; wait for it to finish")
		}
	}
	out, err := h.stackDetail(ctx, p)
	if err != nil {
		return nil, err
	}
	// On a running stack the change runs in the background and may not
	// have reached its files yet: say what's being applied.
	out.Logs = on
	return api.SetStackLogs202JSONResponse(out), nil
}

// switchLogs changes a running stack's files and brings it up on them. If
// that fails, the old files go back and the stack is brought up on them.
func (h *handlers) switchLogs(ctx context.Context, ref string, on bool, log io.Writer) error {
	dir := h.stackLayout(ref).Dir
	what := map[bool]string{true: "turning logs on (starting Logflare and Vector)", false: "turning logs off (removing Logflare and Vector)"}[on]
	fmt.Fprintf(log, "%s\n", what)
	if err := provision.SetLogs(dir, on); err != nil {
		return &recoveredError{fmt.Errorf("didn't change logs: updating the stack's files: %w", err)}
	}
	err := h.bringUp(ctx, ref, log)
	if err == nil {
		return nil
	}
	fmt.Fprintf(log, "\n%s failed: %v; going back\n", what, err)
	if rerr := provision.SetLogs(dir, !on); rerr != nil {
		return fmt.Errorf("%s failed (%v), and restoring the stack's files failed: %w", what, err, rerr)
	}
	// A time of its own: the change may have failed by running out of it.
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), h.deps.Config.Provisioning.StartTimeout)
	defer cancel()
	if uerr := h.bringUp(bctx, ref, log); uerr != nil {
		return fmt.Errorf("%s failed (%v), and the stack didn't come back up: %w", what, err, uerr)
	}
	return &recoveredError{fmt.Errorf("didn't change logs: %w", err)}
}
