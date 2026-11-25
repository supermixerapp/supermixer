package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

// provisioning.studio: new stacks follow it, and when Supermixer starts it
// brings running stacks in line, touching only Studio's container.
func TestStudioSetting(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	dbURL := testDatabase(t)
	configure := func(studio bool) func(*config.Config) {
		return func(c *config.Config) {
			c.Provisioning.Enabled = true
			c.Provisioning.StacksDir = stacks
			c.Provisioning.Docker = fake
			c.Provisioning.PublicHost = "stacks.example"
			c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8290-8291", "54490-54491", "64490-64491"
			c.Provisioning.Studio = studio
		}
	}
	env := newTestEnvDeps(t, dbURL, configure(false), nil)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Studios"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/studios/projects/new-stack", map[string]string{"name": "S"}, &p)
	if s := waitStack(t, admin, p.Ref); s.Status != "running" {
		t.Fatalf("stack: %+v", s)
	}
	dir := filepath.Join(stacks, p.Ref)
	// Starting it removed any Studio container: up leaves one running.
	if log, _ := os.ReadFile(calls); !strings.Contains(string(log), "--profile studio rm --stop --force studio") {
		t.Errorf("starting without Studio didn't remove it:\n%s", log)
	}
	// The project says so too (the "Open Studio" button goes by it).
	var proj struct{ Stack struct{ Studio bool } }
	admin.must(200, "GET", "/projects/"+p.Ref, nil, &proj)
	if proj.Stack.Studio {
		t.Error("project says the stack runs Studio")
	}
	envOf := func() map[string]string {
		e, err := provision.ReadEnv(dir)
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	overlay := func() string {
		b, _ := os.ReadFile(filepath.Join(dir, "supermixer.yml"))
		return string(b)
	}
	// Made without Studio (the default).
	if envOf()[provision.StudioEnv] != "false" || !strings.Contains(overlay(), `profiles: ["studio"]`) {
		t.Fatalf("new stack: %s=%q", provision.StudioEnv, envOf()[provision.StudioEnv])
	}
	// Settings › Infrastructure shows it: disabled, or, once on, running or
	// stopped as Docker says.
	studioState := func() string {
		t.Helper()
		var d struct {
			State *string `json:"studio_state"`
		}
		admin.must(200, "GET", "/projects/"+p.Ref+"/stack", nil, &d)
		if d.State == nil {
			return "null"
		}
		return *d.State
	}
	if s := studioState(); s != "disabled" {
		t.Errorf("studio = %s, want disabled", s)
	}
	if err := provision.UpdateEnv(dir, map[string]string{provision.StudioEnv: "true"}); err != nil {
		t.Fatal(err)
	}
	if s := studioState(); s != "stopped" {
		t.Errorf("studio on, no container: %s, want stopped", s)
	}
	t.Setenv("FAKE_STUDIO_STATE", "running")
	if s := studioState(); s != "running" {
		t.Errorf("studio on and running: %s, want running", s)
	}
	t.Setenv("FAKE_STUDIO_STATE", "exited")
	if s := studioState(); s != "stopped" {
		t.Errorf("studio on, exited: %s, want stopped", s)
	}
	t.Setenv("FAKE_STUDIO_STATE", "")
	if err := provision.UpdateEnv(dir, map[string]string{provision.StudioEnv: "false"}); err != nil {
		t.Fatal(err)
	}

	// A stack from before the setting: no entry, and Studio running.
	raw, _ := os.ReadFile(filepath.Join(dir, ".env"))
	cleaned := regexp.MustCompile(`(?m)^`+provision.StudioEnv+`=.*\n`).ReplaceAll(raw, nil)
	if err := os.WriteFile(filepath.Join(dir, ".env"), cleaned, 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor := func(what string) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			if log, _ := os.ReadFile(calls); strings.Contains(string(log), what) {
				return
			}
		}
		log, _ := os.ReadFile(calls)
		t.Fatalf("docker wasn't asked to %q:\n%s", what, log)
	}
	// Supermixer starting (an instance taking on the background work).
	start := func(studio bool) context.CancelFunc {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		newTestEnvDeps(t, dbURL, configure(studio), func(d *Deps) { d.Background = ctx })
		return cancel
	}
	_ = os.WriteFile(calls, nil, 0o600)
	stop := start(false)
	waitFor("--profile studio rm --stop --force studio")
	if envOf()[provision.StudioEnv] != "false" {
		t.Fatal("not recorded as off")
	}
	stop()

	// Off already, but a Studio container is left running (a removal that
	// failed): it's removed again.
	_ = os.WriteFile(calls, nil, 0o600)
	t.Setenv("FAKE_STUDIO_STATE", "running")
	stop = start(false)
	waitFor("--profile studio rm --stop --force studio")
	stop()
	t.Setenv("FAKE_STUDIO_STATE", "")

	// Turned on: Studio alone is started, nothing else.
	_ = os.WriteFile(calls, nil, 0o600)
	start(true)
	waitFor("up --detach --no-deps studio")
	if envOf()[provision.StudioEnv] != "true" || strings.Contains(overlay(), "profiles:") {
		t.Fatal("not recorded as on")
	}
	if log, _ := os.ReadFile(calls); len(strings.Split(strings.TrimSpace(string(log)), "\n")) != 1 {
		t.Errorf("more than Studio was touched:\n%s", log)
	}
}

// Without Studio, the stack's overlay needs Docker Compose 2.24: an older
// one is refused with a clear message, before anything starts.
func TestStudioOffNeedsCompose224(t *testing.T) {
	t.Setenv("FAKE_COMPOSE_VERSION", "2.23.3")
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = t.TempDir()
		c.Provisioning.Docker = fake
		c.Provisioning.PublicHost = "stacks.example"
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8292-8293", "54492-54493", "64492-64493"
	})
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Old"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/old/projects/new-stack", map[string]string{"name": "S"}, &p)
	s := waitStack(t, admin, p.Ref)
	if s.Status != "failed" || !strings.Contains(s.Error, "2.23.3 is too old") || !strings.Contains(s.Error, "studio = true") {
		t.Fatalf("stack: %+v", s)
	}
	if log, _ := os.ReadFile(calls); strings.Contains(string(log), " up ") {
		t.Errorf("started anyway:\n%s", log)
	}
}
