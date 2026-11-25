package httpapi

import (
	"context"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Rotating a created stack's keys; see provision/rotate.go.

func (h *handlers) RotateStackKeys(ctx context.Context, req api.RotateStackKeysRequestObject) (api.RotateStackKeysResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectUpdate, "rotate this project's keys")
	if err != nil {
		return nil, err
	}
	if !h.deps.Config.Provisioning.Enabled {
		return nil, errProvisioningOff()
	}
	var which []provision.Rotation
	for _, k := range req.Body.Keys {
		r := provision.Rotation(k)
		if !slices.Contains(provision.Rotations, r) {
			return nil, badRequest("can't rotate %q", k)
		}
		if !slices.Contains(which, r) {
			which = append(which, r)
		}
	}
	if len(which) == 0 {
		return nil, badRequest("choose the keys to rotate")
	}
	status := p.StackStatus.StackStatus
	if status != db.StackStatusRunning && status != db.StackStatusPaused {
		return nil, conflict("the stack must be running or paused to rotate its keys")
	}
	started := h.runStack(ctx, p, api.StackOperationRotatingKeys, status, func(ctx context.Context, log io.Writer) error {
		return h.rotateKeys(ctx, p, which, status == db.StackStatusRunning, log)
	})
	if !started {
		return nil, conflict("the stack is busy with another operation; wait for it to finish")
	}
	names := make([]string, len(which))
	for i, r := range which {
		names[i] = string(r)
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.keys_rotated",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"keys": names}})
	out, err := h.stackDetail(ctx, p)
	if err != nil {
		return nil, err
	}
	return api.RotateStackKeys202JSONResponse(out), nil
}

// rotateKeys writes new values to the stack's .env and Supermixer's copy of
// its keys, then, if it runs, brings it up so Compose recreates the services
// whose settings changed (and functions_user gets its new password).
func (h *handlers) rotateKeys(ctx context.Context, p db.Project, which []provision.Rotation, running bool, log io.Writer) error {
	started := time.Now() // advice recorded after this may concern the new keys
	dir := h.stackLayout(p.Ref).Dir
	env, err := provision.ReadEnv(dir)
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't rotate: %w", err)}
	}
	values, err := provision.Rotate(env, which, time.Now())
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't rotate: %w", err)}
	}
	if err := provision.UpdateEnv(dir, values); err != nil {
		return &recoveredError{fmt.Errorf("didn't rotate: %w", err)}
	}
	fmt.Fprintf(log, "\nnew values for %s\n", strings.Join(slices.Sorted(maps.Keys(values)), ", "))
	conn, err := h.connection(p)
	if err != nil {
		return fmt.Errorf("rotated the stack's keys, but couldn't read Supermixer's copy: %w", err)
	}
	maps.Copy(env, values)
	conn.Keys.Anon, conn.Keys.ServiceRole, conn.Keys.JWTSecret = env["ANON_KEY"], env["SERVICE_ROLE_KEY"], env["JWT_SECRET"]
	conn.Keys.Publishable, conn.Keys.Secret = env["SUPABASE_PUBLISHABLE_KEY"], env["SUPABASE_SECRET_KEY"]
	if _, err := h.saveConnection(context.WithoutCancel(ctx), p, conn); err != nil {
		return fmt.Errorf("rotated the stack's keys, but couldn't save Supermixer's copy: %w", err)
	}
	keys := make([]string, len(which))
	for i, r := range which {
		keys[i] = string(r)
	}
	q := h.deps.Store.Queries
	if err := q.RecordKeyRotations(context.WithoutCancel(ctx), db.RecordKeyRotationsParams{ProjectID: p.ID, Keys: keys, StartedAt: started}); err != nil {
		fmt.Fprintf(log, "\ncouldn't record the rotation: %v\n", err)
	} else if _, err := q.ClearAnsweredRotationAdvisories(context.WithoutCancel(ctx),
		db.ClearAnsweredRotationAdvisoriesParams{ProjectID: p.ID, Required: answeringRotations}); err != nil {
		fmt.Fprintf(log, "\ncouldn't clear the advice to rotate: %v\n", err)
	}
	if !running {
		fmt.Fprintf(log, "the stack is paused; it starts with the new keys\n")
		return nil
	}
	if err := h.bringUp(ctx, p.Ref, log); err != nil {
		return fmt.Errorf("rotated the keys, but the stack didn't come back up: %w", err)
	}
	return nil
}
