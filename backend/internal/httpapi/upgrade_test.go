package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

type upgradeView struct {
	Current, Latest string
	UpToDate        bool `json:"up_to_date"`
	Images          []struct{ Service, From, To string }
	NewKeys         []string `json:"new_keys"`
	Blocked         *string
}

func TestUpgradeStack(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	once := filepath.Join(t.TempDir(), "fail-once")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	t.Setenv("FAKE_DOCKER_FAIL_ONCE", once)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	configure := func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.BackupsDir = t.TempDir()
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8260-8261", "54460-54461", "64460-64461"
	}
	env := newTestEnvWith(t, configure)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Up"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/up/projects/new-stack", map[string]string{"name": "x"}, &p)
	waitStack(t, admin, p.Ref)
	base := "/projects/" + p.Ref + "/stack/upgrade"
	dir := filepath.Join(stacks, p.Ref)
	compose := filepath.Join(dir, "docker-compose.yml")
	fresh, _ := os.ReadFile(compose)

	var u upgradeView
	admin.must(200, "GET", base, nil, &u)
	if !u.UpToDate || u.Current != provision.TemplateVersion() || u.Latest != u.Current {
		t.Fatalf("new stack's upgrade = %+v", u)
	}
	admin.must(409, "POST", base, nil, nil)

	// Make it look like a stack from an older template.
	old := strings.Replace(string(fresh), "image: supabase/gotrue:", "image: supabase/gotrue:v2.100.0 #", 1)
	makeOld := func() {
		t.Helper()
		if err := os.WriteFile(compose, []byte(old), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := openTestDB(t, env.dbURL).Exec(t.Context(), `update projects set stack_template = 'oldcommit' where ref = $1`, p.Ref); err != nil {
			t.Fatal(err)
		}
	}
	makeOld()
	admin.must(200, "GET", base, nil, &u)
	if u.UpToDate || u.Current != "oldcommit" || len(u.Images) != 1 || u.Images[0].Service != "auth" || u.Images[0].From != "supabase/gotrue:v2.100.0" {
		t.Fatalf("old stack's upgrade = %+v", u)
	}

	// Developers can see it but not run it.
	dev := joinAs(t, env, admin, "up", "updev", "developer")
	dev.must(200, "GET", base, nil, nil)
	dev.must(403, "POST", base, nil, nil)

	// A stack that doesn't come up on the new version goes back.
	if err := os.WriteFile(once, []byte("up"), 0o600); err != nil {
		t.Fatal(err)
	}
	admin.must(202, "POST", base, nil, nil)
	s := waitStack(t, admin, p.Ref)
	if s.Status != "running" || !strings.Contains(s.Error, "back on its previous version") {
		t.Fatalf("after a failed upgrade: %+v", s)
	}
	if b, _ := os.ReadFile(compose); string(b) != old {
		t.Error("the previous compose file wasn't put back")
	}
	if s.Template != "oldcommit" || provision.UpgradeInterrupted(dir) {
		t.Errorf("template %q, leftover snapshot %v", s.Template, provision.UpgradeInterrupted(dir))
	}

	// A pull that fails changes nothing.
	t.Setenv("FAKE_DOCKER_FAIL", "pull")
	admin.must(202, "POST", base, nil, nil)
	if s := waitStack(t, admin, p.Ref); s.Status != "running" || !strings.Contains(s.Error, "stack is unchanged") {
		t.Fatalf("after a failed pull: %+v", s)
	}
	t.Setenv("FAKE_DOCKER_FAIL", "")

	// The upgrade: a backup, the new files, a pull, the stack brought up.
	_ = os.Truncate(calls, 0)
	admin.must(202, "POST", base, nil, nil)
	if s := waitStack(t, admin, p.Ref); s.Status != "running" || s.Error != "" || s.Template != provision.TemplateVersion() {
		t.Fatalf("after upgrading: %+v", s)
	}
	if b, _ := os.ReadFile(compose); string(b) != string(fresh) {
		t.Error("the compose file wasn't upgraded")
	}
	log, _ := os.ReadFile(calls)
	for _, want := range []string{" pull --quiet", "up --detach --wait --remove-orphans"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("docker calls lack %q:\n%s", want, log)
		}
	}
	list := waitBackups(t, admin, p.Ref)
	if len(list) == 0 || list[0].Kind != "pre_upgrade" || list[0].Status != "completed" {
		t.Errorf("backups = %+v", list)
	}
	admin.must(200, "GET", base, nil, &u)
	if !u.UpToDate {
		t.Errorf("after upgrading: %+v", u)
	}

	// An upgrade Supermixer stopped during is finished on the next start.
	makeOld()
	if _, err := provision.ApplyUpgrade(provision.Layout{Dir: dir, Project: "supermixer-" + p.Ref}, nil); err != nil {
		t.Fatal(err)
	}
	admin.must(202, "POST", "/projects/"+p.Ref+"/stack/stop", nil, nil)
	waitStack(t, admin, p.Ref)
	admin.must(202, "POST", "/projects/"+p.Ref+"/stack/start", nil, nil)
	if s := waitStack(t, admin, p.Ref); s.Status != "running" || s.Template != provision.TemplateVersion() || provision.UpgradeInterrupted(dir) {
		t.Fatalf("after starting an interrupted upgrade: %+v (snapshot left: %v)", s, provision.UpgradeInterrupted(dir))
	}

	var audit struct{ Entries []struct{ Action string } }
	admin.must(200, "GET", "/organizations/up/audit-logs", nil, &audit)
	n := 0
	for _, e := range audit.Entries {
		if e.Action == "project.upgraded" {
			n++
		}
	}
	if n != 3 {
		t.Errorf("project.upgraded audit entries = %d, want 3", n)
	}
}
