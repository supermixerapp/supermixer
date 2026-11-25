package httpapi

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

// Turning a stack's logs off leaves Logflare and Vector out (the compose
// file with them isn't used), the log pages say logs aren't available, and
// log drains can't be added; turning them on brings them back.
func TestStackLogs(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	dbURL := testDatabase(t)
	configure := func(logs bool) func(*config.Config) {
		return func(c *config.Config) {
			c.Provisioning.Enabled = true
			c.Provisioning.StacksDir = stacks
			c.Provisioning.Docker = fake
			c.Provisioning.PublicHost = "stacks.example"
			c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8294-8296", "54494-54496", "64494-64496"
			c.Provisioning.Logs = logs
		}
	}
	env := newTestEnvDeps(t, dbURL, configure(true), nil)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Logs"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/logs/projects/new-stack", map[string]string{"name": "L"}, &p)
	if s := waitStack(t, admin, p.Ref); s.Status != "running" {
		t.Fatalf("stack: %+v", s)
	}
	dir := filepath.Join(stacks, p.Ref)
	type stack struct {
		Status    string
		Error     string
		Operation *string
		Logs      bool
	}
	get := func() stack {
		t.Helper()
		var s stack
		admin.must(200, "GET", "/projects/"+p.Ref+"/stack", nil, &s)
		return s
	}
	settle := func() stack {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			if s := get(); s.Operation == nil {
				return s
			}
		}
		t.Fatal("still busy")
		return stack{}
	}
	lastUp := func() string {
		t.Helper()
		log, _ := os.ReadFile(calls)
		lines := strings.Split(strings.TrimSpace(string(log)), "\n")
		for i := len(lines) - 1; i >= 0; i-- {
			if strings.Contains(lines[i], " up --detach --wait") {
				return lines[i]
			}
		}
		return ""
	}
	if !get().Logs || !strings.Contains(lastUp(), "docker-compose.logs.yml") {
		t.Fatalf("new stack doesn't collect logs: %+v / %s", get(), lastUp())
	}

	// Off, on a running stack: brought up without the logs file, so
	// --remove-orphans removes Logflare and Vector.
	var started stack
	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/logs", map[string]bool{"enabled": false}, &started)
	if started.Logs {
		t.Error("the response doesn't say logs are being turned off")
	}
	if s := settle(); s.Logs || s.Status != "running" || s.Error != "" {
		t.Fatalf("after turning logs off: %+v", s)
	}
	if up := lastUp(); strings.Contains(up, "docker-compose.logs.yml") || !strings.Contains(up, "--remove-orphans") {
		t.Errorf("brought up with: %s", up)
	}
	e, _ := provision.ReadEnv(dir)
	if strings.Contains(e["COMPOSE_FILE"], "logs") {
		t.Errorf("COMPOSE_FILE = %q", e["COMPOSE_FILE"])
	}
	// The log pages say logs aren't there; drains can't be added.
	var logs struct{ Available bool }
	admin.must(200, "GET", "/projects/"+p.Ref+"/logs?source=postgres", nil, &logs)
	if logs.Available {
		t.Error("logs available with logs off")
	}
	admin.must(200, "GET", "/projects/"+p.Ref+"/logs/requests?since="+url.QueryEscape(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)), nil, &logs)
	if logs.Available {
		t.Error("request stats available with logs off")
	}
	var refused struct{ Message string }
	if s := admin.do("POST", "/projects/"+p.Ref+"/log-drains", map[string]any{"name": "d", "type": "http", "url": "https://logs.example/in"}, &refused); s != 409 ||
		!strings.Contains(refused.Message, "logs are off") {
		t.Errorf("adding a drain with logs off: %d %+v", s, refused)
	}

	// Back on; failing once first, which leaves them off and the stack up.
	once := filepath.Join(t.TempDir(), "once")
	_ = os.WriteFile(once, []byte("up"), 0o600)
	t.Setenv("FAKE_DOCKER_FAIL_ONCE", once)
	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/logs", map[string]bool{"enabled": true}, nil)
	if s := settle(); s.Logs || s.Status != "running" || !strings.Contains(s.Error, "didn't change logs") {
		t.Fatalf("after a failed switch: %+v", s)
	}
	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/logs", map[string]bool{"enabled": true}, nil)
	if s := settle(); !s.Logs || s.Status != "running" || s.Error != "" || !strings.Contains(lastUp(), "docker-compose.logs.yml") {
		t.Fatalf("after turning logs on: %+v / %s", s, lastUp())
	}
	// A drain, while logs are on.
	var drain struct{ ID string }
	admin.must(201, "POST", "/projects/"+p.Ref+"/log-drains", map[string]any{"name": "d", "type": "http", "url": "https://logs.example/in"}, &drain)

	// A paused stack: only its files change, for its next start.
	admin.must(202, "POST", "/projects/"+p.Ref+"/stack/stop", nil, nil)
	if s := settle(); s.Status != "paused" {
		t.Fatalf("pausing: %+v", s)
	}
	before := lastUp()
	_ = os.WriteFile(calls, nil, 0o600)
	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/logs", map[string]bool{"enabled": false}, nil)
	if s := get(); s.Logs || s.Status != "paused" || lastUp() != "" {
		t.Errorf("paused: %+v, docker: %q (was %q)", s, lastUp(), before)
	}
	// With logs off, a drain can be removed but not changed.
	admin.must(409, "PATCH", "/projects/"+p.Ref+"/log-drains/"+drain.ID, map[string]any{"name": "d", "type": "http", "url": "https://logs.example/other", "enabled": false}, nil)
	admin.must(204, "DELETE", "/projects/"+p.Ref+"/log-drains/"+drain.ID, nil, nil)
	var drains struct{ Drains []struct{ ID string } }
	admin.must(200, "GET", "/projects/"+p.Ref+"/log-drains", nil, &drains)
	if len(drains.Drains) != 0 {
		t.Errorf("drains after removing: %+v", drains)
	}

	// Each change is in the audit log, but not the one that failed.
	var audit struct {
		Entries []struct{ Action string } `json:"entries"`
	}
	admin.must(200, "GET", "/organizations/logs/audit-logs?limit=100", nil, &audit)
	n := 0
	for _, e := range audit.Entries {
		if e.Action == "project.logs_updated" {
			n++
		}
	}
	if n != 3 {
		t.Errorf("%d project.logs_updated entries, want 3", n)
	}

	// provisioning.logs = false: new stacks start without them.
	env2 := newTestEnvDeps(t, dbURL, configure(false), nil)
	admin2 := env2.client(t)
	admin2.signIn("admin", adminPassword)
	admin2.must(202, "POST", "/organizations/logs/projects/new-stack", map[string]string{"name": "Quiet"}, &p)
	waitStack(t, admin2, p.Ref)
	var s stack
	admin2.must(200, "GET", "/projects/"+p.Ref+"/stack", nil, &s)
	if s.Logs || strings.Contains(lastUp(), "docker-compose.logs.yml") {
		t.Errorf("provisioning.logs = false: %+v / %s", s, lastUp())
	}
}
