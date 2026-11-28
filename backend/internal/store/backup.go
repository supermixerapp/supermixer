package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// migrationBackupsKept is how many pre-migration dumps BackupBeforeMigrate
// keeps.
const migrationBackupsKept = 5

// PendingMigrations reports whether Migrate has migrations to apply to a
// database that already has some: a new install has nothing to back up.
func (s *Store) PendingMigrations(ctx context.Context) (bool, int64, error) {
	pending, err := s.goose.HasPending(ctx)
	if err != nil || !pending {
		return false, 0, err
	}
	version, err := s.goose.GetDBVersion(ctx)
	if err != nil {
		return false, 0, err
	}
	return version > 0, version, nil
}

// BackupBeforeMigrate dumps the database into dir with pg_dump (custom
// format, for pg_restore) when migrations are pending, and keeps the last
// few dumps. It returns the dump's path, or "" when nothing was pending.
func (s *Store) BackupBeforeMigrate(ctx context.Context, databaseURL, dir string) (string, error) {
	pending, version, err := s.PendingMigrations(ctx)
	if err != nil {
		return "", fmt.Errorf("checking for migrations: %w", err)
	}
	if !pending {
		return "", nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("database.migration_backups_dir: %w", err)
	}
	name := fmt.Sprintf("supermixer-schema-%d-%s.dump", version, time.Now().UTC().Format("20060102T150405Z"))
	path := filepath.Join(dir, name)
	if err := pgDump(ctx, databaseURL, path); err != nil {
		return "", err
	}
	prune(dir, migrationBackupsKept, s.logger.Warn)
	return path, nil
}

// pgDump writes the database to path, through a temporary file so a
// failed dump never looks like a backup. The password goes in the
// environment, not on the command line.
func pgDump(ctx context.Context, databaseURL, path string) error {
	u, err := url.Parse(databaseURL)
	if err != nil {
		return fmt.Errorf("parsing database.url: %w", err)
	}
	env := os.Environ()
	if pw, ok := u.User.Password(); ok {
		env = append(env, "PGPASSWORD="+pw)
		u.User = url.User(u.User.Username())
	}
	tmp := path + ".partial"
	cmd := exec.CommandContext(ctx, "pg_dump", "--format=custom", "--file="+tmp, "--dbname="+u.String())
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("pg_dump: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// prune removes all but the newest keep dumps in dir.
func prune(dir string, keep int, warn func(string, ...any)) {
	dumps, _ := filepath.Glob(filepath.Join(dir, "supermixer-schema-*.dump"))
	if len(dumps) <= keep {
		return
	}
	// The timestamp sorts by name; the schema version comes first, so
	// sort by the part after it.
	stamp := func(p string) string { return p[strings.LastIndex(p, "-")+1:] }
	slices.SortFunc(dumps, func(a, b string) int { return strings.Compare(stamp(a), stamp(b)) })
	for _, p := range dumps[:len(dumps)-keep] {
		if err := os.Remove(p); err != nil {
			warn("removing an old database backup", "path", p, "err", err)
		}
	}
}
