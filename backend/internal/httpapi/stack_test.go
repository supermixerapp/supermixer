package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"supermixer/internal/config"
)

type stackView struct {
	Status    string
	Error     string
	Operation *string
	Template  string
	Ports     struct{ Api, Db, Pooler int }
	Services  *[]struct{ Service, State, Health string }
	Log       string
}

// waitStack polls until the stack has no operation running.
func waitStack(t *testing.T, c *client, ref string) stackView {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var s stackView
		c.must(200, "GET", "/projects/"+ref+"/stack", nil, &s)
		if s.Operation == nil {
			return s
		}
		if time.Now().After(deadline) {
			t.Fatalf("stack still %s", *s.Operation)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestCreatedStacks(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.Docker = fake
		c.Provisioning.PublicHost = "stacks.example"
		c.Provisioning.APIPorts = "8200-8203"
		c.Provisioning.DBPorts = "54400-54403"
		c.Provisioning.PoolerPorts = "64400-64403"
	})
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Stacks"}, nil)

	var ui struct{ Provisioning struct{ Enabled bool } }
	admin.must(200, "GET", "/ui-config", nil, &ui)
	if !ui.Provisioning.Enabled {
		t.Fatal("ui-config doesn't say provisioning is on")
	}

	var p struct {
		RefJ     string `json:"ref"`
		APIURL   string `json:"api_url"`
		Studio   string `json:"studio_url"`
		Stack    *struct{ Status string }
		Database struct {
			Host, User string
			Port       int
		}
	}
	admin.must(202, "POST", "/organizations/stacks/projects/new-stack", map[string]string{"name": "Made here"}, &p)
	ref := p.RefJ
	if p.Stack == nil || p.Stack.Status != "provisioning" {
		t.Fatalf("stack = %+v", p.Stack)
	}
	// 8200 is published by another container (see fake-docker.sh).
	if p.Studio != "http://stacks.example:8201" || p.APIURL != "http://stacks.example:8201" {
		t.Fatalf("urls = %s, %s", p.APIURL, p.Studio)
	}
	if p.Database.Port != 54400 || p.Database.User != "postgres."+ref {
		t.Fatalf("database = %+v", p.Database)
	}

	s := waitStack(t, admin, ref)
	if s.Status != "running" || s.Ports.Api != 8201 || s.Template == "" {
		t.Fatalf("after creating: %+v", s)
	}
	if s.Services == nil || len(*s.Services) != 1 || (*s.Services)[0].Health != "healthy" {
		t.Fatalf("services = %+v", s.Services)
	}
	if !strings.Contains(s.Log, "starting done") {
		t.Fatalf("log = %q", s.Log)
	}

	dir := filepath.Join(stacks, ref)
	envFile, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"\nPOSTGRES_PORT=54400\n", "\nAPI_GW_HTTP_PORT=8201\n", "\nPOOLER_TENANT_ID=" + ref + "\n", "\nSUPABASE_PUBLIC_URL=http://stacks.example:8201\n", "\nCOMPOSE_PROJECT_NAME=supermixer-" + ref + "\n"} {
		if !strings.Contains(string(envFile), want) {
			t.Errorf(".env lacks %q", strings.TrimSpace(want))
		}
	}
	if strings.Contains(string(envFile), "your-super-secret") {
		t.Error(".env still has the example's placeholder secrets")
	}
	vector, _ := os.ReadFile(filepath.Join(dir, "volumes/logs/vector.yml"))
	if !strings.Contains(string(vector), "com.docker.compose.project=supermixer-"+ref) {
		t.Error("Vector isn't limited to the stack")
	}

	// A second stack gets the next ports.
	var p2 struct{ Ref string }
	admin.must(202, "POST", "/organizations/stacks/projects/new-stack", map[string]string{"name": "Second"}, &p2)
	if s2 := waitStack(t, admin, p2.Ref); s2.Ports.Api != 8202 || s2.Ports.Db != 54401 || s2.Ports.Pooler != 64401 {
		t.Fatalf("second stack ports = %+v", s2.Ports)
	}

	// Lifecycle.
	admin.must(202, "POST", "/projects/"+ref+"/stack/stop", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "paused" {
		t.Fatalf("after stop: %s", s.Status)
	}
	admin.must(202, "POST", "/projects/"+ref+"/stack/start", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "running" {
		t.Fatalf("after start: %s", s.Status)
	}
	t.Setenv("FAKE_DOCKER_FAIL", "restart")
	admin.must(202, "POST", "/projects/"+ref+"/stack/restart", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "failed" || !strings.Contains(s.Error, "pretend restart failed") {
		t.Fatalf("after a failed restart: %+v", s)
	}
	t.Setenv("FAKE_DOCKER_FAIL", "")
	admin.must(202, "POST", "/projects/"+ref+"/stack/start", nil, nil)
	if s := waitStack(t, admin, ref); s.Status != "running" || s.Error != "" {
		t.Fatalf("after retrying: %+v", s)
	}

	// Permissions and guards.
	reader := joinAs(t, env, admin, "stacks", "stackreader", "read_only")
	reader.must(200, "GET", "/projects/"+ref+"/stack", nil, nil)
	reader.must(403, "POST", "/projects/"+ref+"/stack/stop", nil, nil)
	reader.must(403, "POST", "/organizations/stacks/projects/new-stack", map[string]string{"name": "No"}, nil)
	admin.must(409, "PATCH", "/projects/"+ref, map[string]any{"connection": map[string]any{"api_url": "http://elsewhere:1"}}, nil)
	admin.must(200, "PATCH", "/projects/"+ref, map[string]any{"name": "Renamed"}, nil)

	// Studio's login: generated, and only for members who may see secrets.
	var login struct{ Username, Password string }
	admin.must(200, "POST", "/projects/"+ref+"/studio-login", nil, &login)
	if login.Username != "supabase" || len(login.Password) != 32 || strings.Contains(login.Password, "insecure") {
		t.Fatalf("studio login = %+v", login)
	}
	reader.must(403, "POST", "/projects/"+ref+"/studio-login", nil, nil)

	// Deleting tears the stack down.
	admin.must(204, "DELETE", "/projects/"+ref, nil, nil)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if admin.do("GET", "/projects/"+ref, nil, nil) == 404 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("project still there after deleting")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("stack folder left behind: %v", err)
	}
	log, _ := os.ReadFile(calls)
	if !strings.Contains(string(log), "--project-name supermixer-"+ref) || !strings.Contains(string(log), "down --volumes --remove-orphans") {
		t.Errorf("docker calls:\n%s", log)
	}
	var audit struct {
		Entries []struct {
			Action        string
			ActorUsername string `json:"actor_username"`
		}
	}
	admin.must(200, "GET", "/organizations/stacks/audit-logs", nil, &audit)
	got := map[string]bool{}
	for _, e := range audit.Entries {
		got[e.Action] = true
		// Deleting finishes in the background, but is still the admin's doing.
		if strings.HasPrefix(e.Action, "project.") && e.ActorUsername != "admin" {
			t.Errorf("%s by %q", e.Action, e.ActorUsername)
		}
	}
	for _, want := range []string{"project.created", "project.stack_stopped", "project.stack_started", "project.stack_restarted", "project.deleted"} {
		if !got[want] {
			t.Errorf("audit log lacks %s", want)
		}
	}
}

func TestCreatingStacksNeedsProvisioning(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Off"}, nil)
	admin.must(409, "POST", "/organizations/off/projects/new-stack", map[string]string{"name": "x"}, nil)
}

func TestInterruptedStacksAreMarkedFailed(t *testing.T) {
	stacks := t.TempDir()
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	configure := func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8210-8211", "54410-54411", "64410-64411"
	}
	env := newTestEnvWith(t, configure)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Crash"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/crash/projects/new-stack", map[string]string{"name": "x"}, &p)
	waitStack(t, admin, p.Ref)

	// Pretend Supermixer stopped mid-create, then start a new server.
	conn := openTestDB(t, env.dbURL)
	if _, err := conn.Exec(context.Background(), `update projects set stack_status = 'provisioning', stack_status_at = now() - interval '10 minutes' where ref = $1`, p.Ref); err != nil {
		t.Fatal(err)
	}
	env2 := newTestEnvSharing(t, env, configure)
	c2 := env2.client(t)
	c2.signIn("admin", adminPassword)
	var s stackView
	c2.must(200, "GET", "/projects/"+p.Ref+"/stack", nil, &s)
	if s.Status != "failed" || !strings.Contains(s.Error, "stopped") {
		t.Fatalf("after restart: %+v", s)
	}
}
