package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/provision"
	"supermixer/internal/store/db"
)

// Copies of backups in an S3-compatible bucket (provisioning.backup_s3). A
// backup is taken to backups_dir as before; then an uploader, one backup at
// a time and outside the stack's operation, copies it to the bucket, trying
// again after a failure (2, 4, 8 ... minutes apart, an hour at most). With
// keep_local off, the local files go once the copy is there, and restores
// and downloads fetch them from the bucket.

// Removing a backup's copy from the bucket: its record goes first, and the
// copy is removed after; if the bucket can't be reached, or isn't the one
// configured any more, the copy is noted in backup_leftovers and the
// uploader removes it once it can.

const (
	// uploadTimeout bounds copying one backup to the bucket (a large one can take hours).
	uploadTimeout = 6 * time.Hour
	// removeTimeout bounds removing one backup's objects.
	removeTimeout = 5 * time.Minute
)

// uploader is the one backup being copied, so it isn't removed meanwhile.
// The lock is only held for database work, never for the bucket.
type uploader struct {
	mu      sync.Mutex // claims a backup to upload, or one to remove
	current uuid.UUID
	wake    chan struct{}
}

func newUploader() *uploader { return &uploader{wake: make(chan struct{}, 1)} }

// poke has the uploader look for work now rather than within the minute.
func (u *uploader) poke() {
	select {
	case u.wake <- struct{}{}:
	default:
	}
}

func (h *handlers) s3Prefix() string { return h.deps.Config.Provisioning.BackupS3.Prefix }

// uploadLoop copies backups to the bucket until ctx ends.
func (h *handlers) uploadLoop(ctx context.Context) {
	if err := h.s3.Check(ctx); err != nil {
		h.deps.Logger.Warn("backups can't be copied to S3 until this is fixed", "err", err)
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		h.uploadPending(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-h.uploads.wake:
		}
	}
}

func (h *handlers) uploadPending(ctx context.Context) {
	q := h.deps.Store.Queries
	rows, err := q.PendingUploads(ctx)
	if err != nil {
		h.deps.Logger.Error("listing backups to copy to S3", "err", err)
		return
	}
	for _, r := range rows {
		if ctx.Err() != nil {
			return
		}
		h.uploadBackup(ctx, r.Ref, r.Backup)
	}
	if len(rows) == 20 { // the query's limit: there may be more
		h.uploads.poke()
	}
	if !h.deps.Config.Provisioning.BackupS3.KeepLocal {
		if local, err := q.UploadedLocalBackups(ctx, h.s3.Bucket()); err == nil {
			for _, r := range local {
				h.dropLocal(ctx, r.Ref, r.Backup)
			}
		}
	}
	h.removeLeftovers(ctx)
}

// uploadBackup copies one backup to the bucket and records the outcome.
func (h *handlers) uploadBackup(ctx context.Context, ref string, b db.Backup) {
	q := h.deps.Store.Queries
	u := h.uploads
	u.mu.Lock()
	// Claimed under the lock, after checking it wasn't removed meanwhile.
	cur, err := h.reload(ctx, b)
	if err != nil || cur.UploadedAt != nil || !cur.Local {
		u.mu.Unlock()
		return
	}
	u.current = b.ID
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.current = uuid.Nil
		u.mu.Unlock()
	}()

	key := provision.RemoteBackupKey(h.s3Prefix(), ref, b.ID.String())
	uctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	err = provision.UploadBackup(uctx, h.s3, h.backupDir(ref, b.ID), key)
	if err != nil && ctx.Err() != nil {
		return // Supermixer is stopping: not the upload's fault; it's tried again on start
	}
	bg := context.WithoutCancel(ctx)
	// The project may have been deleted meanwhile, taking the backup's row
	// and files with it: whatever reached the bucket goes too.
	gone := func() bool {
		if _, gerr := h.reload(bg, b); !errors.Is(gerr, pgx.ErrNoRows) {
			return false
		}
		h.removeRemote(bg, ref, h.s3.Bucket(), key)
		return true
	}
	if err != nil {
		if gone() {
			return
		}
		h.deps.Logger.Warn("copying a backup to S3 failed", "ref", ref, "backup", b.ID, "err", err)
		_ = q.MarkBackupUploadFailed(bg, db.MarkBackupUploadFailedParams{ID: b.ID, UploadError: firstLine(err.Error())})
		return
	}
	done, err := q.MarkBackupUploaded(bg, db.MarkBackupUploadedParams{ID: b.ID, RemoteBucket: h.s3.Bucket(), RemoteKey: key})
	if err != nil {
		if !gone() {
			h.deps.Logger.Error("recording a backup's copy in S3", "ref", ref, "backup", b.ID, "err", err)
		}
		return
	}
	if !h.deps.Config.Provisioning.BackupS3.KeepLocal {
		h.dropLocal(bg, ref, done)
	}
}

// dropLocal removes the local files of a backup that's in the bucket.
// Readers that find them gone look again and fetch from the bucket.
func (h *handlers) dropLocal(ctx context.Context, ref string, b db.Backup) {
	if err := h.deps.Store.Queries.SetBackupLocal(ctx, db.SetBackupLocalParams{ID: b.ID, Local: false}); err != nil {
		return
	}
	if err := os.RemoveAll(h.backupDir(ref, b.ID)); err != nil {
		h.deps.Logger.Warn("removing a backup copied to S3", "ref", ref, "backup", b.ID, "err", err)
	}
}

// remoteCopy is where a backup's objects are, if any may be: once uploaded,
// or partly, after an upload that failed or was cut short (even a first
// one, which may not have been recorded).
func (h *handlers) remoteCopy(ref string, b db.Backup) (bucket, key string) {
	if b.RemoteKey != "" {
		return b.RemoteBucket, b.RemoteKey
	}
	if h.s3 != nil && b.Status == db.BackupStatusCompleted {
		return h.s3.Bucket(), provision.RemoteBackupKey(h.s3Prefix(), ref, b.ID.String())
	}
	return "", ""
}

// store is the bucket a backup's copy is in, if Supermixer can reach it.
func (h *handlers) store(bucket string) (provision.ObjectStore, error) {
	if h.s3 == nil {
		return nil, conflict("the backup's copy is in bucket %s, and provisioning.backup_s3 isn't set up", bucket)
	}
	if bucket != h.s3.Bucket() {
		return nil, conflict("the backup's copy is in bucket %s, and Supermixer is set up for bucket %s", bucket, h.s3.Bucket())
	}
	return h.s3, nil
}

// removeBackup deletes a backup: its row, then its copy in the bucket and
// its files.
func (h *handlers) removeBackup(ctx context.Context, ref string, b db.Backup) error {
	u := h.uploads
	u.mu.Lock()
	if u.current == b.ID {
		u.mu.Unlock()
		return conflict("the backup is being copied to the bucket; try again when that's done")
	}
	// Read again under the lock: an upload may have finished since b was loaded.
	cur, err := h.reload(ctx, b)
	if err == nil {
		// With the row gone, the uploader can't claim it: the rest runs unlocked.
		err = h.deps.Store.Queries.DeleteBackup(ctx, cur.ID)
	}
	u.mu.Unlock()
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("backup")
	}
	if err != nil {
		return err
	}
	if bucket, key := h.remoteCopy(ref, cur); key != "" {
		h.removeRemote(ctx, ref, bucket, key)
	}
	if err := os.RemoveAll(h.backupDir(ref, cur.ID)); err != nil {
		h.deps.Logger.Warn("removing a deleted backup's files", "ref", ref, "backup", cur.ID, "err", err)
	}
	return nil
}

// removeRemote deletes the objects under key, or notes them as leftovers
// to remove later if it can't now.
func (h *handlers) removeRemote(ctx context.Context, ref, bucket, key string) {
	ctx = context.WithoutCancel(ctx)
	if h.s3 != nil && bucket == h.s3.Bucket() {
		rctx, cancel := context.WithTimeout(ctx, removeTimeout)
		err := h.s3.RemoveAll(rctx, key)
		cancel()
		if err == nil {
			return
		}
		h.deps.Logger.Warn("removing a backup's copy in S3; trying again later", "ref", ref, "key", key, "err", err)
	} else {
		h.deps.Logger.Warn("a removed backup's copy stays in its bucket until Supermixer is set up for it again",
			"ref", ref, "bucket", bucket, "key", key)
	}
	if err := h.deps.Store.Queries.AddBackupLeftover(ctx, db.AddBackupLeftoverParams{Bucket: bucket, Key: key}); err != nil {
		h.deps.Logger.Error("noting a backup copy to remove later", "bucket", bucket, "key", key, "err", err)
	}
}

// removeLeftovers removes the copies removeRemote couldn't.
func (h *handlers) removeLeftovers(ctx context.Context) {
	q := h.deps.Store.Queries
	rows, err := q.ListBackupLeftovers(ctx, h.s3.Bucket())
	if err != nil {
		return
	}
	for _, r := range rows {
		rctx, cancel := context.WithTimeout(ctx, removeTimeout)
		err := h.s3.RemoveAll(rctx, r.Key)
		cancel()
		if err != nil {
			return // the bucket's still unreachable; next time
		}
		_ = q.DeleteBackupLeftover(ctx, db.DeleteBackupLeftoverParams{Bucket: r.Bucket, Key: r.Key})
	}
}

// reload re-reads a backup.
func (h *handlers) reload(ctx context.Context, b db.Backup) (db.Backup, error) {
	return h.deps.Store.Queries.GetBackup(ctx, db.GetBackupParams{ID: b.ID, ProjectID: b.ProjectID})
}

// openBackupFile streams one of a backup's dumps, from disk or the bucket.
func (h *handlers) openBackupFile(ctx context.Context, ref string, b db.Backup, file string) (io.ReadCloser, error) {
	if b.Local {
		r, err := provision.OpenBackupFile(h.backupDir(ref, b.ID), file)
		if !errors.Is(err, fs.ErrNotExist) {
			return r, err
		}
		if b, err = h.reload(ctx, b); err != nil { // moved to the bucket only, meanwhile
			return nil, err
		}
	}
	if b.RemoteKey == "" {
		return nil, fmt.Errorf("the backup's files are missing: %w", fs.ErrNotExist)
	}
	s, err := h.store(b.RemoteBucket)
	if err != nil {
		return nil, err
	}
	return provision.OpenRemoteBackupFile(ctx, s, b.RemoteKey, file)
}

// workDir, in backups_dir, holds copies of backups being restored, away
// from the projects' folders (which go when a project is deleted).
const workDir = ".work"

// backupFiles puts a copy of a backup's files in a folder of its own, for
// a restore: linked from disk, or downloaded from the bucket. The copy is
// unaffected by the backup being removed meanwhile; cleanup removes it.
func (h *handlers) backupFiles(ctx context.Context, ref string, b db.Backup, log io.Writer) (string, func(), error) {
	work := filepath.Join(h.deps.Config.Provisioning.BackupsDir, workDir, b.ID.String()+"-"+uuid.NewString()[:8])
	cleanup := func() { _ = os.RemoveAll(work) }
	if b.Local {
		err := provision.CopyBackup(h.backupDir(ref, b.ID), work)
		if err == nil {
			return work, cleanup, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", nil, err
		}
		if b, err = h.reload(ctx, b); err != nil { // moved to the bucket only, meanwhile
			return "", nil, err
		}
	}
	if b.RemoteKey == "" {
		return "", nil, errors.New("the backup's files are missing")
	}
	s, err := h.store(b.RemoteBucket)
	if err != nil {
		return "", nil, err
	}
	fmt.Fprintf(nopLog(log), "\ndownloading the backup from s3://%s/%s\n", b.RemoteBucket, b.RemoteKey)
	if err := provision.FetchBackup(ctx, s, b.RemoteKey, work); err != nil {
		return "", nil, err
	}
	return work, cleanup, nil
}

// removeWorkCopies removes copies left by restores a restart cut short.
func (h *handlers) removeWorkCopies() {
	_ = os.RemoveAll(filepath.Join(h.deps.Config.Provisioning.BackupsDir, workDir))
}

// removeRemoteCopies deletes a deleted project's backups from the bucket
// (or notes them to remove later).
func (h *handlers) removeRemoteCopies(ctx context.Context, ref string, rows []db.Backup) {
	type copyAt struct{ bucket, key string }
	copies := map[copyAt]bool{}
	if h.s3 != nil {
		copies[copyAt{h.s3.Bucket(), path.Join(h.s3Prefix(), ref)}] = true // partial uploads too
	}
	for _, b := range rows {
		copies[copyAt{b.RemoteBucket, b.RemoteKey}] = true
	}
	for c := range copies {
		h.removeRemote(ctx, ref, c.bucket, c.key)
	}
}
