package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Upgrading a stack Supermixer created to the Supabase version it bundles;
// see provision/upgrade.go.

func (h *handlers) GetStackUpgrade(ctx context.Context, req api.GetStackUpgradeRequestObject) (api.GetStackUpgradeResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectRead, "view this project")
	if err != nil {
		return nil, err
	}
	plan, err := provision.PlanUpgrade(h.stackLayout(p.Ref))
	if err != nil {
		return nil, newError(http.StatusInternalServerError, "reading the stack's files: %v", err)
	}
	return api.GetStackUpgrade200JSONResponse(toUpgrade(p, plan)), nil
}

func toUpgrade(p db.Project, plan provision.UpgradePlan) api.StackUpgrade {
	out := api.StackUpgrade{
		Current: p.StackTemplate, Latest: plan.To, NewKeys: plan.NewKeys,
		UpToDate: p.StackTemplate == plan.To && len(plan.Images) == 0 && len(plan.NewKeys) == 0,
		Images: make([]struct {
			From    string `json:"from"`
			Service string `json:"service"`
			To      string `json:"to"`
		}, len(plan.Images)),
	}
	if out.NewKeys == nil {
		out.NewKeys = []string{}
	}
	for i, c := range plan.Images {
		out.Images[i].Service, out.Images[i].From, out.Images[i].To = c.Service, c.From, c.To
	}
	if plan.Blocked != "" {
		out.Blocked = &plan.Blocked
	}
	return out
}

// managedStack loads a project with a stack Supermixer created.
func (h *handlers) managedStack(ctx context.Context, ref string, perm rbac.Permission, action string) (*projectAccess, db.Project, error) {
	a, err := h.loadProject(ctx, ref, perm, action)
	if err != nil {
		return nil, db.Project{}, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, db.Project{}, newError(http.StatusConflict, "Supermixer connects to this stack; upgrade it where it runs")
	}
	return a, p, nil
}

func (h *handlers) UpgradeStack(ctx context.Context, req api.UpgradeStackRequestObject) (api.UpgradeStackResponseObject, error) {
	a, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectUpdate, "upgrade this project")
	if err != nil {
		return nil, err
	}
	if !h.deps.Config.Provisioning.Enabled {
		return nil, errProvisioningOff()
	}
	if p.StackStatus.StackStatus != db.StackStatusRunning {
		return nil, conflict("the stack isn't running; start it to upgrade it (its database is backed up first)")
	}
	plan, err := provision.PlanUpgrade(h.stackLayout(p.Ref))
	if err != nil {
		return nil, newError(http.StatusInternalServerError, "reading the stack's files: %v", err)
	}
	if toUpgrade(p, plan).UpToDate {
		return nil, conflict("the stack already runs the Supabase version Supermixer bundles")
	}
	if plan.Blocked != "" {
		return nil, conflict("%s", plan.Blocked)
	}
	user := a.User.User.ID
	started := h.runStackFor(ctx, p, api.StackOperationUpgrading, db.StackStatusRunning, h.restoreTimeout(),
		func(ctx context.Context, log io.Writer) error { return h.upgradeStack(ctx, p, &user, log) })
	if !started {
		return nil, conflict("the stack is busy with another operation; wait for it to finish")
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.upgraded",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name,
		Metadata: map[string]any{"from": p.StackTemplate, "to": plan.To}})
	out, err := h.stackDetail(ctx, p)
	if err != nil {
		return nil, err
	}
	return api.UpgradeStack202JSONResponse(out), nil
}

// upgradeStack moves a running stack to the bundled template:
//  1. back the database up (kind pre_upgrade);
//  2. render the new files, keeping the old ones in .pre-upgrade/;
//  3. pull the new images (the stack keeps running meanwhile);
//  4. bring the stack up on them, recreating the services that changed;
//  5. record the new template and drop the old files.
//
// If 2 or 3 fails, the old files go back and nothing restarted. If 4 fails,
// the old files go back and the stack is brought up on them again.
func (h *handlers) upgradeStack(ctx context.Context, p db.Project, by *uuid.UUID, log io.Writer) error {
	l, c := h.stackLayout(p.Ref), h.compose(p.Ref)
	plan, err := provision.PlanUpgrade(l)
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't upgrade: %w", err)}
	}
	if plan.Blocked != "" {
		return &recoveredError{fmt.Errorf("didn't upgrade: %s", plan.Blocked)}
	}
	fmt.Fprintf(log, "\nupgrading from supabase/docker @ %.7s to %.7s\n", p.StackTemplate, plan.To)
	for _, i := range plan.Images {
		fmt.Fprintf(log, "  %s: %s -> %s\n", i.Service, orNone(i.From), orNone(i.To))
	}
	pre, err := h.startBackup(ctx, p, db.BackupKindPreUpgrade, by)
	if err == nil {
		_, err = h.dump(ctx, p, pre, log)
	}
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't upgrade: backing up the database first failed: %v", firstLine(err.Error()))}
	}
	secrets, err := provision.GenerateSecrets(time.Now())
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't upgrade: %w", err)}
	}
	goBack := func(why error) error {
		if err := provision.RollBackUpgrade(l.Dir); err != nil {
			return fmt.Errorf("upgrade failed (%v), and putting the previous files back failed too: %v", firstLine(why.Error()), err)
		}
		_ = provision.FinishUpgrade(l.Dir)
		return &recoveredError{fmt.Errorf("didn't upgrade, so the stack is unchanged: %v", firstLine(why.Error()))}
	}
	added, err := provision.ApplyUpgrade(l, secrets.Env())
	if err != nil {
		return goBack(err)
	}
	if len(added) > 0 {
		fmt.Fprintf(log, "\nnew settings in .env: %s\n", strings.Join(added, ", "))
	}
	fmt.Fprintf(log, "\npulling the new images\n")
	if err := c.Pull(ctx, log); err != nil {
		return goBack(err)
	}
	if err := h.bringUp(ctx, p.Ref, log); err != nil {
		fmt.Fprintf(log, "\nthe upgraded stack didn't come up (%v); going back to the previous version\n", err)
		// A time of its own: the upgrade may have failed by running out of it.
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), h.deps.Config.Provisioning.StartTimeout)
		defer cancel()
		if rerr := provision.RollBackUpgrade(l.Dir); rerr != nil {
			return fmt.Errorf("upgrade failed (%v), and putting the previous files back failed too: %v; the database was backed up before the upgrade",
				firstLine(err.Error()), rerr)
		}
		if uerr := h.bringUp(bctx, p.Ref, log); uerr != nil {
			return fmt.Errorf("upgrade failed (%v), and the previous version didn't come back up either: %v; the database was backed up before the upgrade (Database › Backups)",
				firstLine(err.Error()), firstLine(uerr.Error()))
		}
		_ = provision.FinishUpgrade(l.Dir)
		return &recoveredError{fmt.Errorf("upgrade failed, so the stack is back on its previous version: %v", firstLine(err.Error()))}
	}
	return h.finishUpgrade(context.WithoutCancel(ctx), p, log)
}

// finishUpgrade records the template the stack's files now come from.
func (h *handlers) finishUpgrade(ctx context.Context, p db.Project, log io.Writer) error {
	dir := h.stackLayout(p.Ref).Dir
	version, err := provision.StackVersion(dir)
	if err != nil {
		return err
	}
	if err := h.deps.Store.Queries.SetStackTemplate(ctx, db.SetStackTemplateParams{ID: p.ID, StackTemplate: version}); err != nil {
		return err
	}
	fmt.Fprintf(log, "\nnow on supabase/docker @ %.7s\n", version)
	return provision.FinishUpgrade(dir)
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}
