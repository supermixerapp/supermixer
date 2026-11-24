package httpapi

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

type backupView struct {
	ID              string `json:"id"`
	Kind, Status    string
	Error           string
	SizeBytes       int64   `json:"size_bytes"`
	PostgresVersion string  `json:"postgres_version"`
	CreatedBy       *string `json:"created_by"`
}

// waitBackups polls until no backup is running.
func waitBackups(t *testing.T, c *client, ref string) []backupView {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var list struct{ Backups []backupView }
		c.must(200, "GET", "/projects/"+ref+"/backups", nil, &list)
		running := false
		for _, b := range list.Backups {
			running = running || b.Status == "running"
		}
		if !running {
			return list.Backups
		}
		if time.Now().After(deadline) {
			t.Fatal("a backup is still running")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestBackups(t *testing.T) {
	stacks, backups := t.TempDir(), t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	restored := filepath.Join(t.TempDir(), "restored.sql")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	t.Setenv("FAKE_DOCKER_STDIN", restored)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.BackupsDir = backups
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8240-8242", "54440-54442", "64440-64442"
	})
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Bk"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/bk/projects/new-stack", map[string]string{"name": "Bk"}, &p)
	ref := p.Ref
	waitStack(t, admin, ref)
	base := "/projects/" + ref + "/backups"

	// Back up now.
	var b backupView
	admin.must(202, "POST", base, nil, &b)
	if b.Kind != "manual" || b.Status != "running" {
		t.Fatalf("started = %+v", b)
	}
	list := waitBackups(t, admin, ref)
	if len(list) != 1 || list[0].Status != "completed" || list[0].PostgresVersion != "17.6" || list[0].CreatedBy == nil || *list[0].CreatedBy != "admin" {
		t.Fatalf("backups = %+v", list)
	}
	dir := filepath.Join(backups, ref, b.ID)
	for _, f := range []string{"roles.sql.gz", "schema.sql.gz", "data.sql.gz", "manifest.json"} {
		if fi, err := os.Stat(filepath.Join(dir, f)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: %v %v", f, fi, err)
		}
	}
	if m, err := provision.ReadBackupManifest(dir); err != nil || m.Project != ref || len(m.Files) != 3 {
		t.Errorf("manifest = %+v, %v", m, err)
	}

	// Download a dump, uncompressed.
	res := admin.raw("GET", base+"/"+b.ID+"/files/data.sql")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(string(body), "a dump by fake-docker.sh") ||
		!strings.Contains(res.Header.Get("Content-Disposition"), ref+"-") {
		t.Fatalf("download: %d %q %q", res.StatusCode, body, res.Header.Get("Content-Disposition"))
	}
	admin.must(400, "GET", base+"/"+b.ID+"/files/secrets.sql", nil, nil)

	// Roles: Developers and Read-Only members see backups but can't take,
	// download or restore them.
	dev := joinAs(t, env, admin, "bk", "bkdev", "developer")
	dev.must(200, "GET", base, nil, nil)
	dev.must(403, "POST", base, nil, nil)
	dev.must(403, "GET", base+"/"+b.ID+"/files/data.sql", nil, nil)
	dev.must(403, "POST", base+"/"+b.ID+"/restore", nil, nil)

	// Restore into the project: a backup of the current database first, a
	// fresh database volume, the dumps replayed in order, the old volume removed.
	_ = os.Truncate(calls, 0)
	admin.must(202, "POST", base+"/"+b.ID+"/restore", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "running" || s.Error != "" {
		t.Fatalf("after restore: %+v", s)
	}
	list = waitBackups(t, admin, ref)
	if len(list) != 2 || list[0].Kind != "pre_restore" || list[0].Status != "completed" {
		t.Fatalf("backups after restore = %+v", list)
	}
	stackEnv, _ := provision.ReadEnv(filepath.Join(stacks, ref))
	if !strings.HasPrefix(stackEnv["DB_DATA_VOLUME"], "db-data-") {
		t.Errorf("DB_DATA_VOLUME = %q", stackEnv["DB_DATA_VOLUME"])
	}
	log, _ := os.ReadFile(calls)
	for _, want := range []string{" stop", "up --detach --wait --remove-orphans", "volume rm supermixer-" + ref + "_db-data"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("docker calls lack %q:\n%s", want, log)
		}
	}
	if sql, _ := os.ReadFile(restored); strings.Count(string(sql), "a dump by fake-docker.sh") != 3 {
		t.Errorf("restored SQL = %q", sql)
	}

	// A restore that fails goes back to the previous database.
	before := stackEnv["DB_DATA_VOLUME"]
	t.Setenv("FAKE_DOCKER_FAIL", "restart")
	admin.must(202, "POST", base+"/"+b.ID+"/restore", nil, nil)
	s := waitStack(t, admin, ref)
	if s.Status != "running" || !strings.Contains(s.Error, "back on its previous database") {
		t.Fatalf("after a failed restore: %+v", s)
	}
	stackEnv, _ = provision.ReadEnv(filepath.Join(stacks, ref))
	if stackEnv["DB_DATA_VOLUME"] != before {
		t.Errorf("DB_DATA_VOLUME = %q, want %q", stackEnv["DB_DATA_VOLUME"], before)
	}
	t.Setenv("FAKE_DOCKER_FAIL", "")

	// A backup isn't restored into another major version of Postgres.
	t.Setenv("FAKE_PG_VERSION", "15.8")
	admin.must(202, "POST", base+"/"+b.ID+"/restore", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "running" || !strings.Contains(s.Error, "from Postgres 17.6") {
		t.Fatalf("after restoring into another version: %+v", s)
	}
	// A database that doesn't say its version fails the backup (no panic).
	t.Setenv("FAKE_PG_VERSION", " ")
	admin.must(202, "POST", base, nil, nil)
	if l := waitBackups(t, admin, ref); l[0].Status != "failed" || !strings.Contains(l[0].Error, "didn't report its version") {
		t.Fatalf("backup without a version = %+v", l[0])
	}
	t.Setenv("FAKE_PG_VERSION", "")
	_ = os.Unsetenv("FAKE_PG_VERSION")

	// A restore Supermixer stopped in the middle of goes back to the
	// previous database when the stack starts.
	stackDir := filepath.Join(stacks, ref)
	before = provision.DataVolume(mustEnv(t, stackDir))
	if err := provision.UpdateEnv(stackDir, map[string]string{provision.RestoringFrom: before, "DB_DATA_VOLUME": "db-data-half"}); err != nil {
		t.Fatal(err)
	}
	admin.must(202, "POST", "/projects/"+ref+"/stack/stop", nil, nil)
	waitStack(t, admin, ref)
	_ = os.Truncate(calls, 0)
	admin.must(202, "POST", "/projects/"+ref+"/stack/start", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "running" || !strings.Contains(s.Error, "restore didn't finish") {
		t.Fatalf("after starting an interrupted restore: %+v", s)
	}
	if e := mustEnv(t, stackDir); e["DB_DATA_VOLUME"] != before || e[provision.RestoringFrom] != "" {
		t.Errorf("env = %q / %q, want %q and no marker", e["DB_DATA_VOLUME"], e[provision.RestoringFrom], before)
	}
	if log, _ := os.ReadFile(calls); !strings.Contains(string(log), "volume rm supermixer-"+ref+"_db-data-half") {
		t.Errorf("the half-restored volume wasn't removed:\n%s", log)
	}

	// Restore into a new project. The backup is copied in, so a failed
	// restore is retried by starting the project, even after the backup's gone.
	keep := backupView{}
	admin.must(202, "POST", base, nil, &keep)
	waitBackups(t, admin, ref)
	t.Setenv("FAKE_DOCKER_FAIL", "restart")
	var failed struct{ Ref string }
	admin.must(202, "POST", base+"/"+keep.ID+"/restore-to-new", map[string]string{"name": "Retry"}, &failed)
	if s := waitStack(t, admin, failed.Ref); s.Status != "failed" || !strings.Contains(s.Error, "restoring the backup") {
		t.Fatalf("new project after a failed restore: %+v", s)
	}
	t.Setenv("FAKE_DOCKER_FAIL", "")
	admin.must(204, "DELETE", base+"/"+keep.ID, nil, nil)
	_ = os.Truncate(restored, 0)
	admin.must(202, "POST", "/projects/"+failed.Ref+"/stack/start", nil, nil)
	if s := waitStack(t, admin, failed.Ref); s.Status != "running" || s.Error != "" {
		t.Fatalf("new project after starting again: %+v", s)
	}
	if sql, _ := os.ReadFile(restored); strings.Count(string(sql), "a dump by fake-docker.sh") != 3 {
		t.Errorf("retried restore replayed %q", sql)
	}
	if _, err := os.Stat(provision.PendingRestore(filepath.Join(stacks, failed.Ref))); !os.IsNotExist(err) {
		t.Errorf("the restored backup is still in the stack's folder: %v", err)
	}

	// Restore into a new project.
	var np struct {
		Ref   string
		Name  string
		Stack *struct{ Status string }
	}
	admin.must(202, "POST", base+"/"+b.ID+"/restore-to-new", map[string]string{"name": "Copy"}, &np)
	if np.Name != "Copy" || np.Ref == ref || np.Stack == nil {
		t.Fatalf("new project = %+v", np)
	}
	if s := waitStack(t, admin, np.Ref); s.Status != "running" {
		t.Fatalf("new project's stack = %+v", s)
	}

	// Delete a backup; deleting the project removes the rest.
	admin.must(204, "DELETE", base+"/"+b.ID, nil, nil)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("deleted backup's folder remains: %v", err)
	}
	admin.must(404, "DELETE", base+"/"+b.ID, nil, nil)
	admin.must(204, "DELETE", "/projects/"+ref, nil, nil)
	deadline := time.Now().Add(10 * time.Second)
	for admin.do("GET", "/projects/"+ref, nil, nil) != 404 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(backups, ref)); !os.IsNotExist(err) {
		t.Errorf("a deleted project's backups remain: %v", err)
	}

	var audit struct{ Entries []struct{ Action string } }
	admin.must(200, "GET", "/organizations/bk/audit-logs", nil, &audit)
	got := map[string]int{}
	for _, e := range audit.Entries {
		got[e.Action]++
	}
	for _, want := range []string{"project.backup_created", "project.backup_downloaded", "project.restored", "project.backup_deleted"} {
		if got[want] == 0 {
			t.Errorf("audit log lacks %s (%v)", want, got)
		}
	}
}

// raw sends a GET and returns the response, for bodies that aren't JSON.
func (c *client) raw(method, path string) *http.Response {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.env.server.URL+"/api/v1"+path, nil)
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	return resp
}

func mustEnv(t *testing.T, dir string) map[string]string {
	t.Helper()
	e, err := provision.ReadEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// A running stack a restore was cut short on (Supermixer stopped while it
// ran on the new database) goes back to its previous one at the next start.
func TestInterruptedRestoreRecovered(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	configure := func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.BackupsDir = t.TempDir()
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8250-8251", "54450-54451", "64450-64451"
	}
	env := newTestEnvWith(t, configure)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Cut"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/cut/projects/new-stack", map[string]string{"name": "x"}, &p)
	waitStack(t, admin, p.Ref)

	dir := filepath.Join(stacks, p.Ref)
	if err := provision.UpdateEnv(dir, map[string]string{provision.RestoringFrom: "db-data", "DB_DATA_VOLUME": "db-data-new"}); err != nil {
		t.Fatal(err)
	}
	conn := openTestDB(t, env.dbURL)
	if _, err := conn.Exec(t.Context(), `update projects set stack_status_at = now() - interval '10 minutes' where ref = $1`, p.Ref); err != nil {
		t.Fatal(err)
	}
	_ = os.Truncate(calls, 0)
	env2 := newTestEnvSharing(t, env, configure)
	c2 := env2.client(t)
	c2.signIn("admin", adminPassword)
	if s := waitStack(t, c2, p.Ref); s.Status != "running" || !strings.Contains(s.Error, "restore didn't finish") {
		t.Fatalf("after restart: %+v", s)
	}
	if e := mustEnv(t, dir); e["DB_DATA_VOLUME"] != "db-data" || e[provision.RestoringFrom] != "" {
		t.Errorf("env = %q / %q", e["DB_DATA_VOLUME"], e[provision.RestoringFrom])
	}
	log, _ := os.ReadFile(calls)
	for _, want := range []string{" stop", "volume rm supermixer-" + p.Ref + "_db-data-new"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("docker calls lack %q:\n%s", want, log)
		}
	}
}
