package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

// memBucket is an in-memory ObjectStore.
type memBucket struct {
	mu       sync.Mutex
	objects  map[string][]byte
	puts     []string // keys, in the order they were uploaded
	fail     bool     // Put fails, after the first object (a partial upload)
	noRemove bool     // RemoveAll fails (the bucket is unreachable)
	name     string
}

func newMemBucket() *memBucket { return &memBucket{objects: map[string][]byte{}, name: "test-bucket"} }

func (m *memBucket) set(f func(m *memBucket)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	f(m)
}

func (m *memBucket) Bucket() string                  { return m.name }
func (m *memBucket) Check(ctx context.Context) error { return nil }

func (m *memBucket) Put(_ context.Context, key, file string) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.fail && strings.HasSuffix(key, "/schema.sql.gz") {
		return errors.New("simulated network error")
	}
	m.objects[key] = b
	m.puts = append(m.puts, key)
	return nil
}

func (m *memBucket) Get(_ context.Context, key string) (io.ReadCloser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, ok := m.objects[key]
	if !ok {
		return nil, fmt.Errorf("%s isn't in the bucket", key)
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

func (m *memBucket) RemoveAll(_ context.Context, prefix string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.noRemove {
		return errors.New("simulated outage")
	}
	for k := range m.objects {
		if strings.HasPrefix(k, prefix+"/") {
			delete(m.objects, k)
		}
	}
	return nil
}

func (m *memBucket) keys(prefix string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for k := range m.objects {
		if strings.HasPrefix(k, prefix) {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

type s3BackupView struct {
	backupView
	Local       bool
	Remote      *string
	UploadError string `json:"upload_error"`
}

// waitFor polls the project's backups until ok says so.
func waitFor(t *testing.T, c *client, ref, what string, ok func([]s3BackupView) bool) []s3BackupView {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var list struct{ Backups []s3BackupView }
		c.must(200, "GET", "/projects/"+ref+"/backups", nil, &list)
		if ok(list.Backups) {
			return list.Backups
		}
		if time.Now().After(deadline) {
			t.Fatalf("waiting for %s: %+v", what, list.Backups)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func byID(list []s3BackupView, id string) s3BackupView {
	for _, b := range list {
		if b.ID == id {
			return b
		}
	}
	return s3BackupView{}
}

func TestBackupsInS3(t *testing.T) {
	stacks, backups := t.TempDir(), t.TempDir()
	restored := filepath.Join(t.TempDir(), "restored.sql")
	t.Setenv("FAKE_DOCKER_STDIN", restored)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	bucket := newMemBucket()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	env := newTestEnvDeps(t, testDatabase(t), func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.BackupsDir = backups
		c.Provisioning.BackupInterval = 0
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8260-8262", "54460-54462", "64460-64462"
		c.Provisioning.BackupS3 = config.BackupS3{Bucket: "test-bucket", Endpoint: "http://s3.test", Prefix: "sm", KeepLocal: false}
	}, func(d *Deps) {
		d.BackupStore = bucket
		d.Background = ctx
	})
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "S3"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/s3/projects/new-stack", map[string]string{"name": "S3"}, &p)
	ref := p.Ref
	waitStack(t, admin, ref)
	base := "/projects/" + ref + "/backups"

	// A backup is copied to the bucket, manifest last, then (keep_local
	// off) removed from disk.
	var b backupView
	admin.must(202, "POST", base, nil, &b)
	key := "sm/" + ref + "/" + b.ID
	got := byID(waitFor(t, admin, ref, "the upload", func(l []s3BackupView) bool {
		x := byID(l, b.ID)
		return x.Remote != nil && !x.Local
	}), b.ID)
	if *got.Remote != "s3://test-bucket/"+key || got.UploadError != "" {
		t.Fatalf("uploaded backup = %+v", got)
	}
	want := []string{key + "/data.sql.gz", key + "/manifest.json", key + "/roles.sql.gz", key + "/schema.sql.gz"}
	if k := bucket.keys(key); !slices.Equal(k, want) {
		t.Fatalf("objects = %v", k)
	}
	bucket.mu.Lock()
	last := bucket.puts[len(bucket.puts)-1]
	bucket.mu.Unlock()
	if last != key+"/manifest.json" {
		t.Errorf("last upload = %s, want the manifest", last)
	}
	if _, err := os.Stat(filepath.Join(backups, ref, b.ID)); !os.IsNotExist(err) {
		t.Errorf("local copy remains: %v", err)
	}
	var list struct {
		S3 *struct {
			Location  string
			KeepLocal bool `json:"keep_local"`
		}
	}
	admin.must(200, "GET", base, nil, &list)
	if list.S3 == nil || list.S3.Location != "s3://test-bucket/sm/"+ref || list.S3.KeepLocal {
		t.Errorf("s3 = %+v", list.S3)
	}

	// Downloads and restores fetch it from the bucket.
	res := admin.raw("GET", base+"/"+b.ID+"/files/data.sql")
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(string(body), "a dump by fake-docker.sh") {
		t.Fatalf("download: %d %q", res.StatusCode, body)
	}
	admin.must(202, "POST", base+"/"+b.ID+"/restore", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "running" || s.Error != "" {
		t.Fatalf("after restore: %+v", s)
	}
	if sql, _ := os.ReadFile(restored); strings.Count(string(sql), "a dump by fake-docker.sh") != 3 {
		t.Errorf("restored SQL = %q", sql)
	}
	if left, _ := filepath.Glob(filepath.Join(backups, workDir, "*")); len(left) > 0 {
		t.Errorf("the restore's copy remains: %v", left)
	}
	var np struct{ Ref string }
	admin.must(202, "POST", base+"/"+b.ID+"/restore-to-new", map[string]string{"name": "From S3"}, &np)
	if s := waitStack(t, admin, np.Ref); s.Status != "running" || s.Error != "" {
		t.Fatalf("new project from the bucket: %+v", s)
	}
	if _, err := os.Stat(provision.PendingRestore(filepath.Join(stacks, np.Ref))); !os.IsNotExist(err) {
		t.Errorf("the pending restore remains: %v", err)
	}
	if sql, _ := os.ReadFile(restored); strings.Count(string(sql), "a dump by fake-docker.sh") != 3 {
		t.Errorf("restored from the bucket: %q", sql)
	}

	// A failed upload keeps the local files, says why, and can be retried.
	bucket.mu.Lock()
	bucket.fail = true
	bucket.mu.Unlock()
	var f backupView
	admin.must(202, "POST", base, nil, &f)
	failed := byID(waitFor(t, admin, ref, "the failed upload", func(l []s3BackupView) bool {
		return byID(l, f.ID).UploadError != ""
	}), f.ID)
	if !failed.Local || failed.Remote != nil || !strings.Contains(failed.UploadError, "simulated network error") {
		t.Fatalf("failed upload = %+v", failed)
	}
	bucket.mu.Lock()
	bucket.fail = false
	bucket.mu.Unlock()
	admin.must(202, "POST", base+"/"+f.ID+"/upload", nil, nil)
	waitFor(t, admin, ref, "the retried upload", func(l []s3BackupView) bool {
		x := byID(l, f.ID)
		return x.Remote != nil && x.UploadError == ""
	})
	admin.must(409, "POST", base+"/"+f.ID+"/upload", nil, nil) // already there

	// Deleting a backup removes it from the bucket; deleting the project, the rest.
	admin.must(204, "DELETE", base+"/"+b.ID, nil, nil)
	if k := bucket.keys(key); len(k) > 0 {
		t.Errorf("deleted backup's objects remain: %v", k)
	}

	// While the bucket can't be reached, a backup is still deleted, and its
	// copy removed once it can.
	conn := openTestDB(t, env.dbURL)
	leftovers := func() int {
		var n int
		_ = conn.QueryRow(t.Context(), `select count(*) from backup_leftovers`).Scan(&n)
		return n
	}
	bucket.set(func(m *memBucket) { m.noRemove = true })
	fkey := "sm/" + ref + "/" + f.ID
	admin.must(204, "DELETE", base+"/"+f.ID, nil, nil)
	if len(bucket.keys(fkey)) == 0 || leftovers() != 1 {
		t.Fatalf("during the outage: objects %v, leftovers %d", bucket.keys(fkey), leftovers())
	}
	bucket.set(func(m *memBucket) { m.noRemove = false })
	var nb backupView
	admin.must(202, "POST", base, nil, &nb) // its upload wakes the uploader
	deadline := time.Now().Add(10 * time.Second)
	for (len(bucket.keys(fkey)) > 0 || leftovers() > 0) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(bucket.keys(fkey)) > 0 || leftovers() > 0 {
		t.Errorf("after the outage: objects %v, leftovers %d", bucket.keys(fkey), leftovers())
	}

	// Objects of an upload cut short before it was recorded go with the backup too.
	waitFor(t, admin, ref, "the new backup's upload", func(l []s3BackupView) bool { return byID(l, nb.ID).Remote != nil })
	nkey := "sm/" + ref + "/" + nb.ID
	if _, err := conn.Exec(t.Context(), `update backups set remote_bucket = '', remote_key = '', uploaded_at = null,
		upload_attempts = 0, local = true where id = $1`, nb.ID); err != nil {
		t.Fatal(err)
	}
	bucket.set(func(m *memBucket) { m.fail = true }) // so the uploader doesn't finish it meanwhile
	admin.must(204, "DELETE", base+"/"+nb.ID, nil, nil)
	if k := bucket.keys(nkey); len(k) > 0 {
		t.Errorf("an unrecorded upload's objects remain: %v", k)
	}
	bucket.set(func(m *memBucket) { m.fail = false })
	if len(bucket.keys("sm/"+ref+"/")) == 0 {
		t.Fatal("expected the project's other backups in the bucket")
	}
	admin.must(204, "DELETE", "/projects/"+ref, nil, nil)
	deadline = time.Now().Add(10 * time.Second)
	for admin.do("GET", "/projects/"+ref, nil, nil) != 404 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if k := bucket.keys("sm/" + ref + "/"); len(k) > 0 {
		t.Errorf("a deleted project's objects remain: %v", k)
	}
}

// Backup files reach the bucket and come back the same.
func TestUploadAndFetchBackup(t *testing.T) {
	src := t.TempDir()
	for _, name := range []string{"roles.sql.gz", "schema.sql.gz", "data.sql.gz", "manifest.json"} {
		if err := os.WriteFile(filepath.Join(src, name), []byte("content of "+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	bucket := newMemBucket()
	if err := provision.UploadBackup(t.Context(), bucket, src, "p/ref/id"); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "copy")
	if err := provision.FetchBackup(t.Context(), bucket, "p/ref/id", dst); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"roles.sql.gz", "schema.sql.gz", "data.sql.gz", "manifest.json"} {
		if b, _ := os.ReadFile(filepath.Join(dst, name)); string(b) != "content of "+name {
			t.Errorf("%s = %q", name, b)
		}
	}
	// A missing object leaves nothing behind.
	_ = bucket.RemoveAll(t.Context(), "p/ref/id")
	gone := filepath.Join(t.TempDir(), "gone")
	if err := provision.FetchBackup(t.Context(), bucket, "p/ref/id", gone); err == nil {
		t.Fatal("expected an error")
	}
	if _, err := os.Stat(gone + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("partial download remains: %v", err)
	}
}

// Switching to another bucket: backups whose copy is in the old one keep
// their local files (Supermixer can't read the old bucket any more), and
// deleting one notes its old copy as a leftover rather than failing.
func TestBackupBucketSwitch(t *testing.T) {
	stacks, backups := t.TempDir(), t.TempDir()
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	dbURL := testDatabase(t)
	configure := func(bucket string, keepLocal bool) func(c *config.Config) {
		return func(c *config.Config) {
			c.Provisioning.Enabled = true
			c.Provisioning.StacksDir = stacks
			c.Provisioning.BackupsDir = backups
			c.Provisioning.BackupInterval = 0
			c.Provisioning.Docker = fake
			c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8272-8273", "54472-54473", "64472-64473"
			c.Provisioning.BackupS3 = config.BackupS3{Bucket: bucket, Endpoint: "http://s3.test", Prefix: "sm", KeepLocal: keepLocal}
		}
	}
	old := newMemBucket()
	ctx1, stop1 := context.WithCancel(context.Background())
	t.Cleanup(stop1)
	env := newTestEnvDeps(t, dbURL, configure("test-bucket", true), func(d *Deps) { d.BackupStore, d.Background = old, ctx1 })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Sw"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/sw/projects/new-stack", map[string]string{"name": "Sw"}, &p)
	waitStack(t, admin, p.Ref)
	var b backupView
	admin.must(202, "POST", "/projects/"+p.Ref+"/backups", nil, &b)
	waitFor(t, admin, p.Ref, "the upload", func(l []s3BackupView) bool { return byID(l, b.ID).Remote != nil })
	stop1()

	other := newMemBucket()
	other.name = "other-bucket"
	ctx2, stop2 := context.WithCancel(context.Background())
	t.Cleanup(stop2)
	env2 := newTestEnvDeps(t, dbURL, configure("other-bucket", false), func(d *Deps) { d.BackupStore, d.Background = other, ctx2 })
	c2 := env2.client(t)
	c2.signIn("admin", adminPassword)
	time.Sleep(200 * time.Millisecond) // the uploader's first pass
	got := byID(waitFor(t, c2, p.Ref, "the list", func([]s3BackupView) bool { return true }), b.ID)
	if !got.Local || got.Remote == nil || !strings.HasPrefix(*got.Remote, "s3://test-bucket/") {
		t.Fatalf("a backup in the old bucket = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(backups, p.Ref, b.ID)); err != nil {
		t.Fatalf("its local files went: %v", err)
	}
	c2.must(204, "DELETE", "/projects/"+p.Ref+"/backups/"+b.ID, nil, nil)
	var bucket, key string
	if err := openTestDB(t, dbURL).QueryRow(t.Context(), `select bucket, key from backup_leftovers`).Scan(&bucket, &key); err != nil ||
		bucket != "test-bucket" || key != "sm/"+p.Ref+"/"+b.ID {
		t.Errorf("leftover = %q %q (%v)", bucket, key, err)
	}
}
