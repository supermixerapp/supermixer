package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"supermixer/internal/config"
)

func TestRotateStackKeys(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.BackupsDir = t.TempDir()
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8270-8271", "54470-54471", "64470-64471"
	})
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Rot"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/rot/projects/new-stack", map[string]string{"name": "x"}, &p)
	waitStack(t, admin, p.Ref)
	base := "/projects/" + p.Ref
	dir := filepath.Join(stacks, p.Ref)

	type keyList = []struct {
		ID    string  `json:"id"`
		Value *string `json:"value"`
	}
	var before, after keyList
	admin.must(200, "GET", base+"/api-keys?reveal=true", nil, &before)
	envBefore := mustEnv(t, dir)

	admin.must(400, "POST", base+"/stack/rotate-keys", map[string]any{"keys": []string{}}, nil)
	admin.must(400, "POST", base+"/stack/rotate-keys", map[string]any{"keys": []string{"postgres_password"}}, nil)
	dev := joinAs(t, env, admin, "rot", "rotdev", "developer")
	dev.must(403, "POST", base+"/stack/rotate-keys", map[string]any{"keys": []string{"secret_key"}}, nil)

	// Running: new values in .env and Supermixer's copy, then the stack is brought up.
	_ = os.Truncate(calls, 0)
	admin.must(202, "POST", base+"/stack/rotate-keys", map[string]any{"keys": []string{"secret_key", "jwt_secret", "signing_key"}}, nil)
	if s := waitStack(t, admin, p.Ref); s.Status != "running" || s.Error != "" {
		t.Fatalf("after rotating: %+v", s)
	}
	envAfter := mustEnv(t, dir)
	for _, k := range []string{"SUPABASE_SECRET_KEY", "JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY", "JWT_KEYS", "ANON_KEY_ASYMMETRIC"} {
		if envAfter[k] == envBefore[k] {
			t.Errorf("%s wasn't rotated", k)
		}
	}
	for _, k := range []string{"SUPABASE_PUBLISHABLE_KEY", "POSTGRES_PASSWORD", "FUNCTIONS_DB_PASSWORD"} {
		if envAfter[k] != envBefore[k] {
			t.Errorf("%s changed", k)
		}
	}
	admin.must(200, "GET", base+"/api-keys?reveal=true", nil, &after)
	for id, envKey := range map[string]string{"secret": "SUPABASE_SECRET_KEY", "anon": "ANON_KEY", "service_role": "SERVICE_ROLE_KEY", "jwt_secret": "JWT_SECRET", "publishable": "SUPABASE_PUBLISHABLE_KEY"} {
		if valueOf(after, id) != envAfter[envKey] {
			t.Errorf("Supermixer's %s doesn't match the stack's .env", id)
		}
	}
	if valueOf(after, "secret") == valueOf(before, "secret") {
		t.Error("the secret key shown didn't change")
	}
	if log, _ := os.ReadFile(calls); !strings.Contains(string(log), "up --detach --wait --remove-orphans") {
		t.Errorf("the stack wasn't brought up:\n%s", log)
	}

	// Paused: only the files change; it starts with the new values.
	admin.must(202, "POST", base+"/stack/stop", nil, nil)
	waitStack(t, admin, p.Ref)
	_ = os.Truncate(calls, 0)
	admin.must(202, "POST", base+"/stack/rotate-keys", map[string]any{"keys": []string{"functions_db_password", "functions_db_password"}}, nil)
	if s := waitStack(t, admin, p.Ref); s.Status != "paused" || s.Error != "" {
		t.Fatalf("after rotating a paused stack: %+v", s)
	}
	if mustEnv(t, dir)["FUNCTIONS_DB_PASSWORD"] == envAfter["FUNCTIONS_DB_PASSWORD"] {
		t.Error("the functions' password wasn't rotated")
	}
	if log, _ := os.ReadFile(calls); strings.Contains(string(log), " up ") {
		t.Errorf("a paused stack was started:\n%s", log)
	}

	var audit struct {
		Entries []struct {
			Action   string
			Metadata map[string]any
		}
	}
	admin.must(200, "GET", "/organizations/rot/audit-logs", nil, &audit)
	found := false
	for _, e := range audit.Entries {
		if e.Action == "project.keys_rotated" {
			found = true
			for _, v := range e.Metadata {
				if s, ok := v.(string); ok && strings.HasPrefix(s, "sb_secret_") {
					t.Error("the audit log holds a key")
				}
			}
		}
	}
	if !found {
		t.Error("no project.keys_rotated audit entry")
	}
}
