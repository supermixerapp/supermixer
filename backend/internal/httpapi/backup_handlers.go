package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Database backups of stacks Supermixer created: Supabase-style
// (database only, as Supabase's own backups)
// dumps (see provision/backup.go), taken on a schedule or on demand, and
// restored into the same project or a new one.

func (h *handlers) backupDir(ref string, id uuid.UUID) string {
	return provision.BackupDir(h.deps.Config.Provisioning.BackupsDir, ref, id.String())
}

// managedBackups loads a project with a stack Supermixer created.
func (h *handlers) managedBackups(ctx context.Context, ref string, perm rbac.Permission, action string) (*projectAccess, db.Project, error) {
	a, err := h.loadProject(ctx, ref, perm, action)
	if err != nil {
		return nil, db.Project{}, err
	}
	p := a.Project()
	if h.stackOf(p) == nil {
		return nil, db.Project{}, newError(http.StatusConflict,
			"Supermixer connects to this stack, so it can't back up its database; back it up where it runs")
	}
	return a, p, nil
}

func (h *handlers) toBackup(ctx context.Context, b db.Backup) api.Backup {
	out := api.Backup{
		Id: b.ID, Kind: api.BackupKind(b.Kind), Status: api.BackupStatus(b.Status), Error: b.Error,
		SizeBytes: b.SizeBytes, Template: b.Template, PostgresVersion: b.PostgresVersion,
		StartedAt: b.StartedAt, FinishedAt: b.FinishedAt, Local: b.Local, UploadError: b.UploadError,
	}
	if b.RemoteKey != "" {
		remote := "s3://" + b.RemoteBucket + "/" + b.RemoteKey
		out.Remote = &remote
	}
	if b.CreatedBy != nil {
		if u, err := h.deps.Store.Queries.GetUserByID(ctx, *b.CreatedBy); err == nil {
			out.CreatedBy = &u.Username
		}
	}
	return out
}

// startBackup records a backup; dump then takes it. The caller holds the
// stack's operation.
func (h *handlers) startBackup(ctx context.Context, p db.Project, kind db.BackupKind, by *uuid.UUID) (db.Backup, error) {
	return h.deps.Store.Queries.CreateBackup(ctx, db.CreateBackupParams{
		ProjectID: p.ID, Kind: kind, Template: p.StackTemplate, CreatedBy: by,
	})
}

// dump takes a recorded backup and saves its outcome. It has start_timeout
// at most, so a backup still running after that was cut short (failStaleBackups).
func (h *handlers) dump(ctx context.Context, p db.Project, b db.Backup, log io.Writer) (db.Backup, error) {
	ctx, cancel := context.WithTimeout(ctx, h.deps.Config.Provisioning.StartTimeout)
	defer cancel()
	dir := h.backupDir(p.Ref, b.ID)
	fmt.Fprintf(nopLog(log), "\n== %s: backing up (%s) ==\n", time.Now().UTC().Format(time.RFC3339), b.Kind)
	size, m, err := h.compose(p.Ref).Backup(ctx, log, dir, provision.BackupManifest{
		ID: b.ID.String(), Project: p.Ref, Template: b.Template, CreatedAt: b.StartedAt,
	})
	status, msg := db.BackupStatusCompleted, ""
	if err != nil {
		status, msg = db.BackupStatusFailed, firstLine(err.Error())
		_ = os.RemoveAll(dir)
		fmt.Fprintf(nopLog(log), "\nbackup failed: %v\n", err)
	}
	done, ferr := h.deps.Store.Queries.FinishBackup(context.WithoutCancel(ctx), db.FinishBackupParams{
		ID: b.ID, Status: status, Error: msg, SizeBytes: size, PostgresVersion: m.PostgresVersion,
	})
	if ferr != nil {
		return b, errors.Join(err, ferr)
	}
	if err == nil && h.s3 != nil {
		h.uploads.poke()
	}
	return done, err
}

func nopLog(w io.Writer) io.Writer {
	if w == nil {
		return io.Discard
	}
	return w
}

// backupInBackground runs a backup as the stack's operation, without
// changing its status (a failed backup doesn't make the stack fail).
func (h *handlers) backupInBackground(reqCtx context.Context, p db.Project, b db.Backup) {
	go func() {
		defer h.stacks.end(p.Ref)
		log := &stackLog{dir: h.stackLayout(p.Ref).Dir}
		defer log.Close()
		if _, err := h.dump(context.WithoutCancel(reqCtx), p, b, log); err != nil {
			h.deps.Logger.Warn("backup failed", "ref", p.Ref, "backup", b.ID, "err", err)
		}
	}()
}

func (h *handlers) ListBackups(ctx context.Context, req api.ListBackupsRequestObject) (api.ListBackupsResponseObject, error) {
	_, p, err := h.managedBackups(ctx, req.Ref, rbac.ProjectRead, "view this project's backups")
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListBackups(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	pv := h.deps.Config.Provisioning
	out := api.ListBackups200JSONResponse{Backups: make([]api.Backup, len(rows)),
		IntervalHours: float32(pv.BackupInterval.Hours()), Keep: pv.BackupKeep}
	for i, b := range rows {
		out.Backups[i] = h.toBackup(ctx, b)
	}
	if h.s3 != nil {
		s3 := pv.BackupS3
		out.S3 = &struct {
			Endpoint  string `json:"endpoint"`
			KeepLocal bool   `json:"keep_local"`
			Location  string `json:"location"`
		}{Endpoint: s3.Endpoint, KeepLocal: s3.KeepLocal, Location: "s3://" + path.Join(h.s3.Bucket(), s3.Prefix, p.Ref)}
	}
	return out, nil
}

// readyForBackup checks a stack can be dumped now.
func (h *handlers) readyForBackup(p db.Project) error {
	if !h.deps.Config.Provisioning.Enabled {
		return errProvisioningOff()
	}
	if p.StackStatus.StackStatus != db.StackStatusRunning {
		return conflict("the stack isn't running; start it to back it up")
	}
	return nil
}

func (h *handlers) CreateBackup(ctx context.Context, req api.CreateBackupRequestObject) (api.CreateBackupResponseObject, error) {
	a, p, err := h.managedBackups(ctx, req.Ref, rbac.ProjectUpdate, "back up this project")
	if err != nil {
		return nil, err
	}
	if err := h.readyForBackup(p); err != nil {
		return nil, err
	}
	if !h.stacks.begin(p.Ref, api.StackOperationBackingUp) {
		return nil, conflict("the stack is busy with another operation; wait for it to finish")
	}
	b, err := h.startBackup(ctx, p, db.BackupKindManual, &a.User.User.ID)
	if err != nil {
		h.stacks.end(p.Ref)
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.backup_created",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"backup": b.ID}})
	h.backupInBackground(ctx, p, b)
	return api.CreateBackup202JSONResponse(h.toBackup(ctx, b)), nil
}

// completedBackup loads one of the project's finished backups.
func (h *handlers) completedBackup(ctx context.Context, p db.Project, id uuid.UUID) (db.Backup, error) {
	b, err := h.deps.Store.Queries.GetBackup(ctx, db.GetBackupParams{ID: id, ProjectID: p.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return b, notFound("backup")
	}
	if err != nil {
		return b, err
	}
	if b.Status != db.BackupStatusCompleted {
		return b, conflict("that backup didn't complete")
	}
	return b, nil
}

func (h *handlers) DeleteBackup(ctx context.Context, req api.DeleteBackupRequestObject) (api.DeleteBackupResponseObject, error) {
	_, p, err := h.managedBackups(ctx, req.Ref, rbac.ProjectUpdate, "delete this project's backups")
	if err != nil {
		return nil, err
	}
	b, err := h.deps.Store.Queries.GetBackup(ctx, db.GetBackupParams{ID: req.Id, ProjectID: p.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("backup")
	}
	if err != nil {
		return nil, err
	}
	if b.Status == db.BackupStatusRunning {
		return nil, conflict("the backup is still running")
	}
	if op := h.stacks.current(p.Ref); op != nil && *op == api.StackOperationRestoring {
		return nil, conflict("the project is being restored; wait for it to finish")
	}
	if err := h.removeBackup(ctx, p.Ref, b); err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.backup_deleted",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"backup": b.ID}})
	return api.DeleteBackup204Response{}, nil
}

func (h *handlers) DownloadBackupFile(ctx context.Context, req api.DownloadBackupFileRequestObject) (api.DownloadBackupFileResponseObject, error) {
	// The data dump has every row, Auth's users included.
	_, p, err := h.managedBackups(ctx, req.Ref, rbac.ProjectUpdate, "download this project's backups")
	if err != nil {
		return nil, err
	}
	if !slices.Contains(provision.BackupFiles, string(req.File)) {
		return nil, badRequest("a backup has %s", strings.Join(provision.BackupFiles, ", "))
	}
	b, err := h.completedBackup(ctx, p, req.Id)
	if err != nil {
		return nil, err
	}
	r, err := h.openBackupFile(ctx, p.Ref, b, string(req.File))
	if err != nil {
		var he *apiError
		if errors.As(err, &he) {
			return nil, err
		}
		return nil, newError(http.StatusNotFound, "can't read the backup: %v", err)
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.backup_downloaded",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"backup": b.ID, "file": req.File}})
	name := fmt.Sprintf(`attachment; filename="%s-%s-%s"`, p.Ref, b.StartedAt.UTC().Format("20060102-1504"), req.File)
	return api.DownloadBackupFile200ApplicationoctetStreamResponse{
		Body: r, Headers: api.DownloadBackupFile200ResponseHeaders{ContentDisposition: &name},
	}, nil
}

func (h *handlers) RestoreBackup(ctx context.Context, req api.RestoreBackupRequestObject) (api.RestoreBackupResponseObject, error) {
	a, p, err := h.managedBackups(ctx, req.Ref, rbac.ProjectUpdate, "restore this project")
	if err != nil {
		return nil, err
	}
	b, err := h.completedBackup(ctx, p, req.Id)
	if err != nil {
		return nil, err
	}
	if err := h.readyForBackup(p); err != nil { // the current database is backed up first
		return nil, err
	}
	user := a.User.User.ID
	started := h.runStackFor(ctx, p, api.StackOperationRestoring, db.StackStatusRunning, h.restoreTimeout(),
		func(ctx context.Context, log io.Writer) error {
			return h.restoreInPlace(ctx, p, b, &user, log)
		})
	if !started {
		return nil, conflict("the stack is busy with another operation; wait for it to finish")
	}
	h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.restored",
		TargetType: "project", TargetID: p.Ref, TargetName: p.Name,
		Metadata: map[string]any{"backup": b.ID, "backup_started_at": b.StartedAt}})
	out, err := h.stackDetail(ctx, p)
	if err != nil {
		return nil, err
	}
	return api.RestoreBackup202JSONResponse(out), nil
}

// restoreInPlace replaces the project's database with a backup:
//  1. check the backup is from the same major version of Postgres;
//  2. back the current database up (kind pre_restore);
//  3. note the current volume in .env (provision.RestoringFrom), then stop
//     the stack and start it on a fresh database volume;
//  4. replay the backup, then restart so every service sees the restored data;
//  5. clear the note and remove the old volume.
//
// If 3 or 4 fails, the stack goes back to the old volume, untouched. If
// Supermixer stops partway, the note sends it back there on the next start
// (upStack), or at once if it's running (recoverRestores).
func (h *handlers) restoreInPlace(ctx context.Context, p db.Project, b db.Backup, by *uuid.UUID, log io.Writer) error {
	c := h.compose(p.Ref)
	current, err := c.ServerVersion(ctx, log)
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't restore: %v", firstLine(err.Error()))}
	}
	if err := provision.SameMajorVersion(b.PostgresVersion, current); err != nil {
		return &recoveredError{fmt.Errorf("didn't restore: %w", err)}
	}
	if b.Template != p.StackTemplate {
		fmt.Fprintf(log, "\nthe backup is from Supabase template %.7s; this stack runs %.7s\n", b.Template, p.StackTemplate)
	}
	src, cleanup, err := h.backupFiles(ctx, p.Ref, b, log)
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't restore: %v", firstLine(err.Error()))}
	}
	defer cleanup()
	pre, err := h.startBackup(ctx, p, db.BackupKindPreRestore, by)
	if err == nil {
		_, err = h.dump(ctx, p, pre, log)
	}
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't restore: backing up the current database first failed: %v", firstLine(err.Error()))}
	}
	dir := h.stackLayout(p.Ref).Dir
	env, err := provision.ReadEnv(dir)
	if err != nil {
		return &recoveredError{fmt.Errorf("didn't restore: %w", err)}
	}
	old, fresh := provision.DataVolume(env), provision.FreshDataVolume(time.Now())
	if err := provision.UpdateEnv(dir, map[string]string{provision.RestoringFrom: old}); err != nil {
		return &recoveredError{fmt.Errorf("didn't restore: %w", err)}
	}
	attempt := func() error {
		if err := c.Stop(ctx, log); err != nil {
			return err
		}
		if err := provision.UpdateEnv(dir, map[string]string{"DB_DATA_VOLUME": fresh}); err != nil {
			return err
		}
		if err := h.bringUp(ctx, p.Ref, log); err != nil {
			return err
		}
		fmt.Fprintf(log, "\nrestoring the backup into the fresh database\n")
		if err := c.Restore(ctx, log, src); err != nil {
			return err
		}
		return c.RestartAndWait(ctx, log)
	}
	if err := attempt(); err != nil {
		fmt.Fprintf(log, "\nrestore failed (%v); going back to the previous database\n", err)
		// A time of its own: the restore may have failed by running out of it.
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), h.deps.Config.Provisioning.StartTimeout)
		defer cancel()
		back := func() error {
			if err := c.Stop(bctx, log); err != nil {
				return err
			}
			if err := provision.UpdateEnv(dir, map[string]string{"DB_DATA_VOLUME": old, provision.RestoringFrom: ""}); err != nil {
				return err
			}
			return h.bringUp(bctx, p.Ref, log)
		}
		if berr := back(); berr != nil {
			return fmt.Errorf("restore failed (%v), and going back to the previous database failed too: %v; start the stack to try again",
				firstLine(err.Error()), berr)
		}
		if rerr := c.RemoveVolume(bctx, log, fresh); rerr != nil {
			fmt.Fprintf(log, "\nthe failed restore's volume is left over: %v\n", rerr)
		}
		return &recoveredError{fmt.Errorf("restore failed, so the project is back on its previous database: %v", firstLine(err.Error()))}
	}
	if err := provision.UpdateEnv(dir, map[string]string{provision.RestoringFrom: ""}); err != nil {
		// Left set, the next start would go back to the old database.
		return fmt.Errorf("restored, but couldn't update the stack's .env (%v); remove %s from it before starting the stack again",
			err, provision.RestoringFrom)
	}
	if err := c.RemoveVolume(ctx, log, old); err != nil {
		fmt.Fprintf(log, "\nthe previous database's volume is left over: %v\n", err)
	}
	return nil
}

// restorePending replays the backup a new project was created from (see
// upStack), then removes it from the stack's folder.
func (h *handlers) restorePending(ctx context.Context, ref, pending string, log io.Writer) error {
	src := pending
	if r, ok, err := provision.ReadRemoteRestore(pending); err != nil {
		return err
	} else if ok {
		s, err := h.store(r.Bucket)
		if err != nil {
			return err
		}
		src = pending + "-download" // in the stack's folder: it goes with the project
		_ = os.RemoveAll(src)
		defer os.RemoveAll(src)
		fmt.Fprintf(log, "\ndownloading the backup from s3://%s/%s\n", r.Bucket, r.Key)
		if err := provision.FetchBackup(ctx, s, r.Key, src); err != nil {
			return fmt.Errorf("downloading the backup from the bucket (was it deleted?): %w", err)
		}
	}
	m, err := provision.ReadBackupManifest(src)
	if err != nil {
		return err
	}
	c := h.compose(ref)
	current, err := c.ServerVersion(ctx, log)
	if err != nil {
		return err
	}
	if err := provision.SameMajorVersion(m.PostgresVersion, current); err != nil {
		return err
	}
	fmt.Fprintf(log, "\nrestoring a backup of %s from %s\n", m.Project, m.CreatedAt.UTC().Format(time.RFC3339))
	if err := c.Restore(ctx, log, src); err != nil {
		return err
	}
	if err := c.RestartAndWait(ctx, log); err != nil {
		return err
	}
	return os.RemoveAll(pending)
}

func (h *handlers) RestoreBackupToNewProject(ctx context.Context, req api.RestoreBackupToNewProjectRequestObject) (api.RestoreBackupToNewProjectResponseObject, error) {
	if !h.deps.Config.Provisioning.Enabled {
		return nil, errProvisioningOff()
	}
	a, p, err := h.managedBackups(ctx, req.Ref, rbac.ProjectUpdate, "restore this project's backups")
	if err != nil {
		return nil, err
	}
	b, err := h.completedBackup(ctx, p, req.Id)
	if err != nil {
		return nil, err
	}
	org, err := h.loadOrg(ctx, a.Row.OrganizationSlug, rbac.ProjectsCreate, "add projects")
	if err != nil {
		return nil, err
	}
	// The backup is copied into the new stack's folder now, so deleting it
	// (or its project) meanwhile doesn't matter, and starting the new project
	// again retries the restore until it succeeds. One that's only in the
	// bucket is downloaded when the stack starts instead (restorePending), not
	// during this request: it may take a while.
	if !b.Local {
		if _, err := h.store(b.RemoteBucket); err != nil {
			return nil, err
		}
	}
	out, err := h.createStack(ctx, org, req.Body.Name,
		map[string]any{"restored_from": map[string]any{"project": p.Ref, "backup": b.ID}},
		func(dir string) error {
			b := b
			if b.Local {
				err := provision.StageRestore(h.backupDir(p.Ref, b.ID), dir)
				if err == nil {
					return nil
				}
				if !errors.Is(err, fs.ErrNotExist) {
					return newError(http.StatusInternalServerError, "copying the backup: %v", err)
				}
				if b, err = h.reload(ctx, b); err != nil { // moved to the bucket only, meanwhile
					return err
				}
			}
			if b.RemoteKey == "" {
				return conflict("the backup's files are missing")
			}
			return provision.StageRemoteRestore(dir, provision.RemoteRestore{Bucket: b.RemoteBucket, Key: b.RemoteKey})
		})
	if err != nil {
		return nil, err
	}
	return api.RestoreBackupToNewProject202JSONResponse(out), nil
}

// ---------------------------------------------------------------- schedule

// backupLoop takes scheduled backups until ctx ends: every minute, each
// running stack whose last scheduled backup is older than the interval, one
// at a time; then removes the oldest beyond backup_keep.
func (h *handlers) backupLoop(ctx context.Context) {
	h.removeWorkCopies()
	h.failStaleBackups(ctx)
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.failStaleBackups(ctx)
			h.scheduledBackups(ctx)
		}
	}
}

// failStaleBackups fails backups running longer than a dump may take (a
// restart, of this server or another, cut them short) and removes their
// partial files.
func (h *handlers) failStaleBackups(ctx context.Context) {
	rows, err := h.deps.Store.Queries.FailStaleBackups(ctx,
		time.Now().Add(-h.deps.Config.Provisioning.StartTimeout-2*time.Minute))
	if err != nil {
		h.deps.Logger.Error("failing interrupted backups", "err", err)
		return
	}
	for _, r := range rows {
		if err := os.RemoveAll(h.backupDir(r.Ref, r.ID)); err != nil {
			h.deps.Logger.Warn("removing an interrupted backup's files", "ref", r.Ref, "backup", r.ID, "err", err)
		}
	}
}

func (h *handlers) scheduledBackups(ctx context.Context) {
	pv := h.deps.Config.Provisioning
	if !pv.Enabled || pv.BackupInterval <= 0 {
		return
	}
	stacks, err := h.deps.Store.Queries.ListRunningStacksForBackup(ctx)
	if err != nil {
		h.deps.Logger.Error("listing stacks to back up", "err", err)
		return
	}
	for _, p := range stacks {
		if ctx.Err() != nil {
			return
		}
		last, err := h.deps.Store.Queries.LastScheduledBackup(ctx, p.ID)
		if err != nil || time.Since(last) < pv.BackupInterval {
			continue
		}
		if !h.stacks.begin(p.Ref, api.StackOperationBackingUp) {
			continue // busy; next minute
		}
		func() {
			defer h.stacks.end(p.Ref)
			b, err := h.startBackup(ctx, p, db.BackupKindScheduled, nil)
			if err != nil {
				return
			}
			log := &stackLog{dir: h.stackLayout(p.Ref).Dir}
			defer log.Close()
			if _, err := h.dump(ctx, p, b, log); err != nil {
				h.deps.Logger.Warn("scheduled backup failed", "ref", p.Ref, "err", err)
			}
			h.pruneBackups(ctx, p)
		}()
	}
}

// pruneBackups removes scheduled backups beyond backup_keep: completed
// ones, and failed ones (kept as many, to show what went wrong).
func (h *handlers) pruneBackups(ctx context.Context, p db.Project) {
	for _, status := range []db.BackupStatus{db.BackupStatusCompleted, db.BackupStatusFailed} {
		old, err := h.deps.Store.Queries.OldScheduledBackups(ctx, db.OldScheduledBackupsParams{
			ProjectID: p.ID, Status: status, Keep: int32(h.deps.Config.Provisioning.BackupKeep),
		})
		if err != nil {
			return
		}
		for _, b := range old {
			if err := h.removeBackup(ctx, p.Ref, b); err != nil {
				h.deps.Logger.Warn("removing an old backup", "ref", p.Ref, "backup", b.ID, "err", err)
			}
		}
	}
}

func (h *handlers) RetryBackupUpload(ctx context.Context, req api.RetryBackupUploadRequestObject) (api.RetryBackupUploadResponseObject, error) {
	_, p, err := h.managedBackups(ctx, req.Ref, rbac.ProjectUpdate, "back up this project")
	if err != nil {
		return nil, err
	}
	if h.s3 == nil {
		return nil, conflict("backups aren't copied to a bucket: provisioning.backup_s3 isn't set up")
	}
	b, err := h.completedBackup(ctx, p, req.Id)
	if err != nil {
		return nil, err
	}
	if b.UploadedAt != nil {
		return nil, conflict("the backup is already in the bucket")
	}
	if b, err = h.deps.Store.Queries.RetryBackupUpload(ctx, db.RetryBackupUploadParams{ID: b.ID, ProjectID: p.ID}); err != nil {
		return nil, err
	}
	h.uploads.poke()
	return api.RetryBackupUpload202JSONResponse(h.toBackup(ctx, b)), nil
}
