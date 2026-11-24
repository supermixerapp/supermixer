package httpapi

import (
	"path/filepath"
	"testing"

	"supermixer/internal/config"
)

// Someone who could read a project's keys losing that access leaves advice
// to rotate them, until a rotation covers the full-access keys or it's dismissed.
func TestRotationAdvisories(t *testing.T) {
	stacks := t.TempDir()
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.BackupsDir = t.TempDir()
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8274-8275", "54474-54475", "64474-64475"
	})
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Adv"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/adv/projects/new-stack", map[string]string{"name": "x"}, &p)
	waitStack(t, admin, p.Ref)
	advice := "/projects/" + p.Ref + "/rotation-advisories"
	type advisory struct{ Username, Reason string }
	list := func() []advisory {
		var out []advisory
		admin.must(200, "GET", advice, nil, &out)
		return out
	}
	userID := func(name string) string {
		var members []struct {
			UserID   string `json:"user_id"`
			Username string
		}
		admin.must(200, "GET", "/organizations/adv/members", nil, &members)
		for _, m := range members {
			if m.Username == name {
				return m.UserID
			}
		}
		t.Fatalf("no member %s", name)
		return ""
	}

	dev := joinAs(t, env, admin, "adv", "advdev", "developer")
	joinAs(t, env, admin, "adv", "advro", "read_only")
	joinAs(t, env, admin, "adv", "advdev2", "developer")
	joinAs(t, env, admin, "adv", "advdev3", "developer")
	if l := list(); len(l) != 0 {
		t.Fatalf("advisories at the start: %+v", l)
	}

	// Read-only members can't read keys: removing one advises nothing.
	admin.must(204, "DELETE", "/organizations/adv/members/"+userID("advro"), nil, nil)
	// A Developer could: removed, demoted, or leaving, each is advice.
	admin.must(200, "PATCH", "/organizations/adv/members/"+userID("advdev2"), map[string]any{"role": "read_only"}, nil)
	admin.must(204, "DELETE", "/organizations/adv/members/"+userID("advdev3"), nil, nil)
	dev.must(204, "DELETE", "/organizations/adv/members/"+userID("advdev"), nil, nil)
	l := list()
	want := []advisory{{"advdev2", "role_changed"}, {"advdev3", "removed"}, {"advdev", "left"}}
	if len(l) != len(want) {
		t.Fatalf("advisories = %+v", l)
	}
	for i := range want {
		if l[i] != want[i] {
			t.Errorf("advisory %d = %+v, want %+v", i, l[i], want[i])
		}
	}

	// Rotating only the publishable key doesn't answer it; the secret key and JWT secret do.
	rotate := func(keys ...string) {
		admin.must(202, "POST", "/projects/"+p.Ref+"/stack/rotate-keys", map[string]any{"keys": keys}, nil)
		waitStack(t, admin, p.Ref)
	}
	rotate("publishable_key")
	if len(list()) != 3 {
		t.Fatal("a partial rotation cleared the advice")
	}
	rotate("secret_key", "jwt_secret")
	if l := list(); len(l) != 0 {
		t.Fatalf("after rotating: %+v", l)
	}

	// An instance admin disabling an account advises for its projects; dismissing clears it.
	joinAs(t, env, admin, "adv", "advgone", "administrator")
	admin.must(200, "PATCH", "/admin/users/"+userID("advgone"), map[string]any{"disabled": true}, nil)
	if l := list(); len(l) != 1 || l[0] != (advisory{"advgone", "disabled"}) {
		t.Fatalf("after disabling: %+v", l)
	}
	admin.must(204, "DELETE", advice, nil, nil)

	// Moving the project to another organization: its Developers there lose
	// access; the owner, a member of both, doesn't.
	joinAs(t, env, admin, "adv", "advmover", "developer")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Adv2"}, nil)
	admin.must(200, "POST", "/projects/"+p.Ref+"/transfer", map[string]any{"organization_slug": "adv2"}, nil)
	if l := list(); len(l) != 1 || l[0] != (advisory{"advmover", "transferred"}) {
		t.Fatalf("after moving: %+v", l)
	}
	admin.must(200, "POST", "/projects/"+p.Ref+"/transfer", map[string]any{"organization_slug": "adv"}, nil)

	ro := joinAs(t, env, admin, "adv", "advro2", "read_only")
	ro.must(403, "GET", advice, nil, nil)
	ro.must(403, "DELETE", advice, nil, nil)
	admin.must(204, "DELETE", advice, nil, nil)
	if l := list(); len(l) != 0 {
		t.Fatalf("after dismissing: %+v", l)
	}
}
