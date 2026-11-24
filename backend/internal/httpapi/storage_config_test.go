package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

func TestStorageSettingsOfCreatedStacks(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8240-8241", "54440-54441", "64440-64441"
	})
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Store"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/store/projects/new-stack", map[string]string{"name": "S"}, &p)
	waitStack(t, admin, p.Ref)
	base := "/projects/" + p.Ref
	dir := filepath.Join(stacks, p.Ref)

	type settings struct {
		FileSizeLimit       int64 `json:"file_size_limit"`
		ImageTransformation bool  `json:"image_transformation"`
		Restarted           *bool
	}
	var c settings
	admin.must(200, "GET", base+"/storage/config", nil, &c)
	if c.FileSizeLimit != 50<<20 || !c.ImageTransformation {
		t.Fatalf("defaults = %+v", c)
	}

	// A change goes to .env, which the overlay hands Storage, and Storage restarts.
	_ = os.Truncate(calls, 0)
	admin.must(200, "PATCH", base+"/storage/config", map[string]any{"file_size_limit": 200 << 20, "image_transformation": false}, &c)
	if c.FileSizeLimit != 200<<20 || c.ImageTransformation || c.Restarted == nil || !*c.Restarted {
		t.Fatalf("after patch = %+v", c)
	}
	dotEnv := mustEnv(t, dir)
	if dotEnv["STORAGE_FILE_SIZE_LIMIT"] != "209715200" || dotEnv["STORAGE_IMAGE_TRANSFORMATION"] != "false" {
		t.Fatalf(".env = %v / %v", dotEnv["STORAGE_FILE_SIZE_LIMIT"], dotEnv["STORAGE_IMAGE_TRANSFORMATION"])
	}
	overlay, _ := os.ReadFile(filepath.Join(dir, "supermixer.yml"))
	if !strings.Contains(string(overlay), "FILE_SIZE_LIMIT: ${STORAGE_FILE_SIZE_LIMIT:-52428800}") {
		t.Fatalf("overlay:\n%s", overlay)
	}
	if log, _ := os.ReadFile(calls); !strings.Contains(string(log), "--force-recreate storage") {
		t.Errorf("docker calls:\n%s", log)
	}
	// The same values again: nothing written, no restart, nothing audited.
	_ = os.Truncate(calls, 0)
	admin.must(200, "PATCH", base+"/storage/config", map[string]any{"file_size_limit": 200 << 20, "image_transformation": false}, &c)
	if c.Restarted == nil || *c.Restarted {
		t.Fatalf("no-op patch = %+v", c)
	}
	if log, _ := os.ReadFile(calls); strings.Contains(string(log), "storage") {
		t.Errorf("a no-op restarted Storage:\n%s", log)
	}
	if n := countActions(t, admin, "store", "project.storage_config_updated", ""); n != 1 {
		t.Errorf("%d storage_config_updated entries, want 1", n)
	}

	// A value edited by hand is reported (Storage gets it as is); saving replaces it.
	if err := provision.UpdateEnv(dir, map[string]string{"STORAGE_FILE_SIZE_LIMIT": "100MB"}); err != nil {
		t.Fatal(err)
	}
	var withProblem struct {
		FileSizeLimit int64 `json:"file_size_limit"`
		Problems      []struct{ Setting, Message string }
	}
	admin.must(200, "GET", base+"/storage/config", nil, &withProblem)
	if withProblem.FileSizeLimit != 50<<20 || len(withProblem.Problems) != 1 ||
		withProblem.Problems[0].Setting != "file_size_limit" || !strings.Contains(withProblem.Problems[0].Message, `"100MB"`) {
		t.Fatalf("hand-edited = %+v", withProblem)
	}
	withProblem.Problems = nil // omitted when there are none
	admin.must(200, "PATCH", base+"/storage/config", map[string]any{"file_size_limit": 50 << 20}, &withProblem)
	if len(withProblem.Problems) != 0 || mustEnv(t, dir)["STORAGE_FILE_SIZE_LIMIT"] != "52428800" {
		t.Fatalf("after replacing it = %+v", withProblem)
	}

	admin.must(400, "PATCH", base+"/storage/config", map[string]any{"file_size_limit": 10}, nil)
	admin.must(400, "PATCH", base+"/storage/config", map[string]any{}, nil)
	reader := joinAs(t, env, admin, "store", "storereader", "read_only")
	reader.must(200, "GET", base+"/storage/config", nil, nil)
	reader.must(403, "PATCH", base+"/storage/config", map[string]any{"image_transformation": true}, nil)

	// S3: the endpoint and region for anyone; the secret only for those who may see secrets.
	type s3 struct {
		Endpoint        string
		Managed         bool
		Region          *string
		AccessKeyID     *string `json:"access_key_id"`
		SecretAccessKey *string `json:"secret_access_key"`
	}
	var conn s3
	reader.must(200, "GET", base+"/storage/s3", nil, &conn)
	if !conn.Managed || !strings.HasSuffix(conn.Endpoint, "/storage/v1/s3") || conn.Region == nil || conn.AccessKeyID == nil ||
		*conn.AccessKeyID == "" || conn.SecretAccessKey != nil {
		t.Fatalf("s3 = %+v", conn)
	}
	reader.must(403, "GET", base+"/storage/s3?reveal=true", nil, nil)
	if n := countActions(t, admin, "store", "project.secrets_revealed", "s3_keys"); n != 0 {
		t.Fatalf("%d reveals audited before any", n)
	}
	admin.must(200, "GET", base+"/storage/s3?reveal=true", nil, &conn)
	if conn.SecretAccessKey == nil || *conn.SecretAccessKey != dotEnv["S3_PROTOCOL_ACCESS_KEY_SECRET"] {
		t.Fatalf("revealed = %+v", conn)
	}
	if n := countActions(t, admin, "store", "project.secrets_revealed", "s3_keys"); n != 1 {
		t.Errorf("%d S3 reveals audited, want 1", n)
	}

	// New keys, through key rotation.
	before := *conn.AccessKeyID
	admin.must(202, "POST", base+"/stack/rotate-keys", map[string]any{"keys": []string{"s3_keys"}}, nil)
	if s := waitStack(t, admin, p.Ref); s.Error != "" {
		t.Fatalf("after rotating: %+v", s)
	}
	admin.must(200, "GET", base+"/storage/s3", nil, &conn)
	after := mustEnv(t, dir)
	if *conn.AccessKeyID == before || after["S3_PROTOCOL_ACCESS_KEY_ID"] != *conn.AccessKeyID || after["ANON_KEY"] != dotEnv["ANON_KEY"] {
		t.Fatalf("rotated: %s → %s", before, *conn.AccessKeyID)
	}
}

// Stacks Supermixer connects to set Storage's settings where they run.
func TestStorageSettingsOfRegisteredStacks(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Reg"}, nil)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/reg/projects", map[string]any{"name": "R", "connection": connectionFor(t, fakeGateway(t), env.dbURL)}, &p)
	admin.must(409, "GET", "/projects/"+p.Ref+"/storage/config", nil, nil)
	var conn struct {
		Endpoint    string
		Managed     bool
		AccessKeyID *string `json:"access_key_id"`
	}
	admin.must(200, "GET", "/projects/"+p.Ref+"/storage/s3", nil, &conn)
	if conn.Managed || conn.AccessKeyID != nil || !strings.HasSuffix(conn.Endpoint, "/storage/v1/s3") {
		t.Fatalf("s3 = %+v", conn)
	}
}

// countActions counts an organization's audit entries with an action (and,
// if given, a "secret" in their metadata).
func countActions(t *testing.T, c *client, org, action, secret string) int {
	t.Helper()
	var audit struct {
		Entries []struct {
			Action   string
			Metadata map[string]any
		} `json:"entries"`
	}
	c.must(200, "GET", "/organizations/"+org+"/audit-logs?limit=100", nil, &audit)
	n := 0
	for _, e := range audit.Entries {
		if e.Action == action && (secret == "" || e.Metadata["secret"] == secret) {
			n++
		}
	}
	return n
}
