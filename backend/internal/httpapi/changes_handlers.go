package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/advisors"
	"supermixer/internal/api"
	"supermixer/internal/rbac"
	"supermixer/internal/stack"
	"supermixer/internal/store/db"
)

// Advisors › Changes: snapshots of a project database's objects that could
// keep someone in (see advisors/changes.go), compared with the database now.

// snapshotRunner is how to read a project's database for a snapshot: in a
// created stack's db container as supabase_admin (a superuser), or through
// Supermixer's connection to a connected one.
func (h *handlers) snapshotRunner(p db.Project) (advisors.Runner, bool, error) {
	if h.stackOf(p) != nil {
		if p.StackStatus.StackStatus != db.StackStatusRunning {
			return nil, false, conflict("the stack isn't running; start it to read its database")
		}
		return h.compose(p.Ref).QueryJSON, true, nil
	}
	conn, err := h.connection(p)
	if err != nil {
		return nil, false, err
	}
	run := func(ctx context.Context, sql string) ([]byte, error) {
		results, err := h.pools.Query(ctx, p.Ref, conn.Database, sql, stack.QueryOptions{
			ReadOnly: true, Trusted: true, MaxRows: 1, Timeout: h.deps.Config.Projects.QueryTimeout,
		})
		if err != nil {
			return nil, err
		}
		if len(results) == 0 || len(results[len(results)-1].Rows) == 0 || len(results[len(results)-1].Rows[0]) == 0 {
			return nil, errors.New("the query returned nothing")
		}
		switch v := results[len(results)-1].Rows[0][0].(type) {
		case json.RawMessage:
			return v, nil
		case string:
			return []byte(v), nil
		case []byte:
			return v, nil
		default:
			return json.Marshal(v)
		}
	}
	return run, false, nil
}

// readError turns a failure to read a project's database into a response.
func readError(err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		return err
	}
	return newError(http.StatusBadGateway, "could not read the project's database: %s", stack.Describe(err))
}

func (h *handlers) takeSnapshot(ctx context.Context, p db.Project, reason, detail, by string) (db.AddDBSnapshotRow, error) {
	run, superuser, err := h.snapshotRunner(p)
	if err != nil {
		return db.AddDBSnapshotRow{}, err
	}
	snap, err := advisors.Take(ctx, run, superuser)
	if err != nil {
		return db.AddDBSnapshotRow{}, readError(err)
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return db.AddDBSnapshotRow{}, err
	}
	q := h.deps.Store.Queries
	// One before a deploy that finds nothing changed since the last snapshot
	// isn't kept: repeated deploys don't fill the history with copies.
	if reason == "function_deploy" {
		if last, err := q.LatestDBSnapshotData(ctx, p.ID); err == nil {
			var prev advisors.Snapshot
			if json.Unmarshal(last, &prev) == nil && advisors.Same(prev, snap) {
				return db.AddDBSnapshotRow{}, nil
			}
		}
	}
	row, err := q.AddDBSnapshot(ctx, db.AddDBSnapshotParams{ProjectID: p.ID, Reason: reason, Detail: detail, TakenBy: by, Data: data})
	if err != nil {
		return row, err
	}
	_ = q.PruneDBSnapshots(ctx, p.ID)
	return row, nil
}

// snapshotBeforeDeploy takes a snapshot before a function changes, if it
// can: deployed code can change the database, and this is what to compare
// with afterwards. It runs holding the stack; a failure doesn't stop the deploy.
func (h *handlers) snapshotBeforeDeploy(ctx context.Context, p db.Project, name string) {
	if p.StackStatus.StackStatus != db.StackStatusRunning {
		return
	}
	sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if _, err := h.takeSnapshot(sctx, p, "function_deploy", name, username(ctx)); err != nil {
		h.deps.Logger.Warn("snapshot before a function deploy", "ref", p.Ref, "function", name, "err", err)
	}
}

func toDBSnapshot(id [16]byte, takenAt time.Time, reason, detail, by string) api.DBSnapshot {
	return api.DBSnapshot{Id: id, TakenAt: takenAt, Reason: api.DBSnapshotReason(reason), Detail: detail, TakenBy: by}
}

func (h *handlers) ListDBSnapshots(ctx context.Context, req api.ListDBSnapshotsRequestObject) (api.ListDBSnapshotsResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectSecretsRead, "review this project's database changes")
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListDBSnapshots(ctx, a.Project().ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListDBSnapshots200JSONResponse, len(rows))
	for i, r := range rows {
		out[i] = toDBSnapshot(r.ID, r.TakenAt, r.Reason, r.Detail, r.TakenBy)
	}
	return out, nil
}

func (h *handlers) CreateDBSnapshot(ctx context.Context, req api.CreateDBSnapshotRequestObject) (api.CreateDBSnapshotResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectUpdate, "take snapshots of this project's database")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	row, err := h.takeSnapshot(ctx, p, "manual", "", a.User.User.Username)
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.snapshot_taken",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"snapshot": row.ID}})
	return api.CreateDBSnapshot201JSONResponse(toDBSnapshot(row.ID, row.TakenAt, row.Reason, row.Detail, row.TakenBy)), nil
}

func (h *handlers) GetDBChanges(ctx context.Context, req api.GetDBChangesRequestObject) (api.GetDBChangesResponseObject, error) {
	a, err := h.loadProject(ctx, req.Ref, rbac.ProjectSecretsRead, "review this project's database changes")
	if err != nil {
		return nil, err
	}
	p := a.Project()
	q := h.deps.Store.Queries
	id := req.Params.Since
	if id == nil {
		rows, err := q.ListDBSnapshots(ctx, p.ID)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, newError(http.StatusNotFound, "there's no snapshot to compare with yet; take one first")
		}
		id = &rows[0].ID
	}
	snap, err := q.GetDBSnapshot(ctx, db.GetDBSnapshotParams{ID: *id, ProjectID: p.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("snapshot")
	}
	if err != nil {
		return nil, err
	}
	var before advisors.Snapshot
	if err := json.Unmarshal(snap.Data, &before); err != nil {
		return nil, fmt.Errorf("snapshot %s: %w", snap.ID, err)
	}
	run, superuser, err := h.snapshotRunner(p)
	if err != nil {
		return nil, err
	}
	now, err := advisors.Take(ctx, run, superuser)
	if err != nil {
		return nil, readError(err)
	}
	diffs := advisors.Diff(before, now)
	// Auth users are kept by id; show who they are now.
	var users []string
	for _, d := range diffs {
		if d.Name == "auth_users" {
			for _, c := range append(d.Added, d.Changed...) {
				users = append(users, c.Key)
			}
		}
	}
	emails := map[string]string{}
	if len(users) > 0 && len(users) <= 1000 {
		if emails, err = advisors.UserEmails(ctx, run, users); err != nil {
			emails = map[string]string{}
		}
	}
	out := api.GetDBChanges200JSONResponse{
		Since:     toDBSnapshot(snap.ID, snap.TakenAt, snap.Reason, snap.Detail, snap.TakenBy),
		CheckedAt: time.Now().UTC(), Superuser: superuser,
	}
	conv := func(cs []advisors.Change) []api.DBChange {
		res := make([]api.DBChange, len(cs))
		for i, c := range cs {
			res[i] = api.DBChange{Key: c.Key}
			if c.Before != nil {
				res[i].Before = c.Before
			}
			if c.After != nil {
				res[i].After = c.After
			}
			if e := emails[c.Key]; e != "" {
				res[i].Label = &e
			}
		}
		return res
	}
	for _, d := range diffs {
		cat := struct {
			Added   []api.DBChange `json:"added"`
			Changed []api.DBChange `json:"changed"`
			Label   string         `json:"label"`
			Name    string         `json:"name"`
			Removed []api.DBChange `json:"removed"`
			Skipped *string        `json:"skipped,omitempty"`
		}{Added: conv(d.Added), Changed: conv(d.Changed), Removed: conv(d.Removed), Label: d.Label, Name: d.Name}
		if d.Skipped != "" {
			cat.Skipped = &d.Skipped
		}
		out.Categories = append(out.Categories, cat)
	}
	return out, nil
}
