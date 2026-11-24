package provision

import (
	"bufio"
	"cmp"
	"compress/gzip"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Backups are Supabase-style dumps, made the way `supabase db dump` makes
// them (dumpscripts/, from the Supabase CLI): roles, then the schema without
// Supabase-managed schemas, then the data (Auth's and Storage's included).
// The scripts run inside the stack's db container, so pg_dump matches its
// server, and stream out through `docker compose exec`. A restore replays
// them into a freshly started database, as Supabase documents for moving a
// project. Storage files and the Vault aren't included, as on Supabase.

//go:embed dumpscripts/*.sh
var dumpScripts embed.FS

// The Supabase CLI's lists (apps/cli/src/command-internal/pg-dump.env.ts).
var (
	// internalSchemas are left out of the schema dump.
	internalSchemas = []string{"information_schema", "pg_*", "_analytics", "_realtime", "_supavisor", "auth", "etl",
		"extensions", "pgbouncer", "realtime", "storage", "supabase_functions", "supabase_migrations", "cron", "dbdev",
		"graphql", "graphql_public", "net", "pgmq", "pgsodium", "pgsodium_masks", "pgtle", "repack", "tiger",
		"tiger_data", "timescaledb_*", "_timescaledb_*", "topology", "vault"}
	// excludedDataSchemas are left out of the data dump (Auth's and Storage's data stay in).
	excludedDataSchemas = []string{"information_schema", "pg_*", "graphql", "graphql_public", "pgsodium",
		"pgsodium_masks", "pgtle", "repack", "tiger", "tiger_data", "timescaledb_*", "_timescaledb_*", "topology",
		"vault", "etl", "extensions", "pgbouncer", "realtime", "supabase_migrations", "_analytics", "_realtime", "_supavisor"}
	// reservedRoles aren't recreated by a restore; Supermixer adds its own
	// functions_user, which every stack start creates (functions_db.go).
	reservedRoles = []string{"anon", "authenticated", "authenticator", "cli_login_.*", "dashboard_user", "pgbouncer",
		"postgres", "service_role", "supabase_.*", "pgsodium_keyholder", "pgsodium_keyiduser", "pgsodium_keymaker", "pgtle_admin",
		FunctionsDBRole}
	allowedConfigs = []string{"pgaudit.*", "pgrst.*", "session_replication_role", "statement_timeout", "track_io_timing"}
)

// BackupFiles are a backup's dumps, in the order they're restored.
var BackupFiles = []string{"roles.sql", "schema.sql", "data.sql"}

// BackupManifest describes a backup, next to its files.
type BackupManifest struct {
	ID              string    `json:"id"`
	Project         string    `json:"project"`
	Template        string    `json:"template"`
	PostgresVersion string    `json:"postgres_version"`
	CreatedAt       time.Time `json:"created_at"`
	Files           []string  `json:"files"`
	Format          string    `json:"format"`
}

// BackupDir is where one backup's files go.
func BackupDir(backupsDir, ref, id string) string { return filepath.Join(backupsDir, ref, id) }

// dbExec runs a command in the stack's db container as supabase_admin over
// the local socket, with stdin and stdout given; stderr goes to log.
func (c Compose) dbExec(ctx context.Context, log io.Writer, stdin io.Reader, stdout io.Writer, env map[string]string, cmd ...string) error {
	args := []string{"exec", "-T", "-e", "PGHOST=/var/run/postgresql", "-e", "PGUSER=supabase_admin"}
	for k, v := range env {
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, "db")
	args = append(args, cmd...)
	x := exec.CommandContext(ctx, c.Docker, c.args(args...)...)
	x.Dir = c.Layout.Dir
	x.Stdin, x.Stdout = stdin, stdout
	tail := &tailWriter{max: 20}
	x.Stderr = io.MultiWriter(tail, nopWriter(log))
	if err := x.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("%s: %w", cmd[0], ctx.Err())
		}
		return fmt.Errorf("%s failed: %v\n%s", cmd[0], err, tail.String())
	}
	return nil
}

// ServerVersion is the stack's Postgres version, such as "17.6".
func (c Compose) ServerVersion(ctx context.Context, log io.Writer) (string, error) {
	var out strings.Builder
	if err := c.dbExec(ctx, log, nil, &out, nil, "psql", "-d", "postgres", "-AtX", "-c", "show server_version"); err != nil {
		return "", err
	}
	fields := strings.Fields(out.String())
	if len(fields) == 0 {
		return "", fmt.Errorf("the database didn't report its version")
	}
	return fields[0], nil
}

// SameMajorVersion refuses to restore a backup into another major version
// of Postgres: Supabase's dumps aren't meant to cross them.
func SameMajorVersion(backup, target string) error {
	major := func(v string) string { return strings.SplitN(v, ".", 2)[0] }
	if backup == "" || major(backup) != major(target) {
		return fmt.Errorf("the backup is from Postgres %s, and this database runs %s; restore it into a stack with the same major version",
			cmp.Or(backup, "(unknown)"), target)
	}
	return nil
}

func dumpEnv(file string) map[string]string {
	switch file {
	case "roles.sql":
		return map[string]string{"RESERVED_ROLES": strings.Join(reservedRoles, "|"),
			"ALLOWED_CONFIGS": strings.Join(allowedConfigs, "|"), "EXTRA_SED": "/^--/d"}
	case "schema.sql":
		return map[string]string{"EXCLUDED_SCHEMAS": strings.Join(internalSchemas, "|"), "EXTRA_SED": "/^--/d"}
	default: // data.sql, with COPY (as the docs' --use-copy), less Storage's vector tables
		return map[string]string{"INCLUDED_SCHEMAS": "*", "EXCLUDED_SCHEMAS": strings.Join(excludedDataSchemas, "|"),
			"EXTRA_FLAGS": `--exclude-table "storage"."buckets_vectors" --exclude-table "storage"."vector_indexes"`}
	}
}

func dumpScript(file string) []byte {
	name := map[string]string{"roles.sql": "dump_role.sh", "schema.sql": "dump_schema.sh", "data.sql": "dump_data.sh"}[file]
	b, _ := dumpScripts.ReadFile("dumpscripts/" + name)
	return b
}

// Backup dumps a running stack's database into dir (which must not exist):
// gzipped roles, schema and data, and a manifest. It returns the bytes written.
func (c Compose) Backup(ctx context.Context, log io.Writer, dir string, m BackupManifest) (int64, BackupManifest, error) {
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return 0, m, err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return 0, m, err
	}
	version, err := c.ServerVersion(ctx, log)
	if err != nil {
		return 0, m, err
	}
	m.PostgresVersion = version
	var total int64
	for _, file := range BackupFiles {
		fmt.Fprintf(nopWriter(log), "dumping %s\n", file)
		n, err := c.dumpTo(ctx, log, file, filepath.Join(dir, file+".gz"))
		if err != nil {
			return 0, m, fmt.Errorf("%s: %w", file, err)
		}
		total += n
	}
	m.Files = BackupFiles
	m.Format = "supabase-db-dump (roles.sql, schema.sql, data.sql), gzipped"
	b, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o600); err != nil {
		return 0, m, err
	}
	return total, m, nil
}

func (c Compose) dumpTo(ctx context.Context, log io.Writer, file, path string) (int64, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	zw := gzip.NewWriter(f)
	bw := bufio.NewWriterSize(zw, 1<<20)
	if err := c.dbExec(ctx, log, strings.NewReader(string(dumpScript(file))), bw, dumpEnv(file), "bash", "-s"); err != nil {
		return 0, err
	}
	if err := bw.Flush(); err != nil {
		return 0, err
	}
	if err := zw.Close(); err != nil {
		return 0, err
	}
	if err := f.Sync(); err != nil {
		return 0, err
	}
	fi, err := f.Stat()
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

// OpenBackupFile streams one of a backup's dumps, uncompressed.
func OpenBackupFile(dir, file string) (io.ReadCloser, error) {
	valid := false
	for _, f := range BackupFiles {
		valid = valid || f == file
	}
	if !valid {
		return nil, fmt.Errorf("a backup has %s", strings.Join(BackupFiles, ", "))
	}
	f, err := os.Open(filepath.Join(dir, file+".gz"))
	if err != nil {
		return nil, err
	}
	return gunzip(f)
}

// gunzip reads r uncompressed, closing it with the result.
func gunzip(r io.ReadCloser) (io.ReadCloser, error) {
	zr, err := gzip.NewReader(r)
	if err != nil {
		r.Close()
		return nil, err
	}
	return readCloser{zr, func() error { zr.Close(); return r.Close() }}, nil
}

type readCloser struct {
	io.Reader
	close func() error
}

func (r readCloser) Close() error { return r.close() }

// Restore replays a backup into the stack's database, in one transaction:
// roles, schema, then data (with triggers off, as the data dump sets). The
// database should be freshly started from the same template.
func (c Compose) Restore(ctx context.Context, log io.Writer, dir string) error {
	var readers []io.Reader
	for _, file := range BackupFiles {
		r, err := OpenBackupFile(dir, file)
		if err != nil {
			return err
		}
		defer r.Close()
		readers = append(readers, r, strings.NewReader("\n"))
	}
	return c.dbExec(ctx, log, io.MultiReader(readers...), io.Discard, nil,
		"psql", "-d", "postgres", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-")
}

// ReadBackupManifest reads a backup's manifest.
func ReadBackupManifest(dir string) (BackupManifest, error) {
	var m BackupManifest
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("manifest.json: %w", err)
	}
	return m, nil
}

// PendingRestore is where a new project keeps the backup it's created from
// until the restore succeeds, so starting it again retries the restore.
func PendingRestore(stackDir string) string { return filepath.Join(stackDir, "restore") }

// StageRestore copies a backup into a stack's folder as its pending restore.
func StageRestore(src, stackDir string) error { return CopyBackup(src, PendingRestore(stackDir)) }

// RemoteRestore is a pending restore of a backup that's only in a bucket:
// it's downloaded when the stack starts, which retries until it succeeds,
// rather than while the project is being created.
type RemoteRestore struct {
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
}

const remoteRestoreFile = "remote.json"

// StageRemoteRestore makes a backup in a bucket the stack's pending restore.
func StageRemoteRestore(stackDir string, r RemoteRestore) error {
	dst := PendingRestore(stackDir)
	tmp := dst + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.Mkdir(tmp, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(r)
	if err := os.WriteFile(filepath.Join(tmp, remoteRestoreFile), b, 0o600); err != nil {
		_ = os.RemoveAll(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// ReadRemoteRestore reads a pending restore's bucket copy, if it has one
// rather than the files.
func ReadRemoteRestore(pending string) (RemoteRestore, bool, error) {
	var r RemoteRestore
	b, err := os.ReadFile(filepath.Join(pending, remoteRestoreFile))
	if errors.Is(err, os.ErrNotExist) {
		return r, false, nil
	}
	if err != nil {
		return r, false, err
	}
	if err := json.Unmarshal(b, &r); err != nil || r.Bucket == "" || r.Key == "" {
		return r, false, fmt.Errorf("%s: not a backup in a bucket", remoteRestoreFile)
	}
	return r, true, nil
}

// CopyBackup copies a backup's files to dst, which is only there once every
// file is (hard links when they share a file system: backups don't change).
func CopyBackup(src, dst string) error {
	tmp := dst + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(filepath.Dir(tmp), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(tmp, 0o700); err != nil {
		return err
	}
	for _, name := range append(slices.Clone(BackupFiles), "manifest.json") {
		file := name
		if name != "manifest.json" {
			file += ".gz"
		}
		if err := linkOrCopy(filepath.Join(src, file), filepath.Join(tmp, file)); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
	}
	return os.Rename(tmp, dst)
}

func linkOrCopy(src, dst string) error {
	if os.Link(src, dst) == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// RestoringFrom, in a stack's .env, names the database volume a restore in
// place switched away from, until the restore succeeds or is undone. If it's
// still set when the stack starts, the restore was interrupted: the stack
// goes back to that volume.
const RestoringFrom = "DB_DATA_VOLUME_BEFORE_RESTORE"

// DataVolume is the stack's current database volume (see the overlay), and
// FreshDataVolume a new name for restoring into.
func DataVolume(env map[string]string) string {
	if v := env["DB_DATA_VOLUME"]; v != "" {
		return v
	}
	return "db-data"
}

func FreshDataVolume(now time.Time) string { return "db-data-" + now.UTC().Format("20060102150405") }

// RemoveVolume deletes one of the stack's Docker volumes by its short name.
func (c Compose) RemoveVolume(ctx context.Context, log io.Writer, name string) error {
	full := c.Layout.Project + "_" + name
	out, err := exec.CommandContext(ctx, c.Docker, "volume", "rm", full).CombinedOutput()
	fmt.Fprintf(nopWriter(log), "%s", out)
	if err != nil && !strings.Contains(string(out), "no such volume") {
		return fmt.Errorf("removing volume %s: %v", full, err)
	}
	return nil
}

// RemoveProjectVolumes deletes every volume Compose made for the stack,
// including database volumes left by restores.
func (c Compose) RemoveProjectVolumes(ctx context.Context, log io.Writer) error {
	out, err := exec.CommandContext(ctx, c.Docker, "volume", "ls", "-q", "--filter",
		"label=com.docker.compose.project="+c.Layout.Project).Output()
	if err != nil {
		return err
	}
	var errs []error
	for _, v := range strings.Fields(string(out)) {
		if b, err := exec.CommandContext(ctx, c.Docker, "volume", "rm", v).CombinedOutput(); err != nil {
			errs = append(errs, fmt.Errorf("%s: %v %s", v, err, b))
		}
	}
	return errors.Join(errs...)
}
