package httpapi

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"supermixer/internal/config"
)

func TestAuthConfigOfCreatedStacks(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8230-8231", "54430-54431", "64430-64431"
	})
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Authy"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/authy/projects/new-stack", map[string]string{"name": "A"}, &p)
	waitStack(t, admin, p.Ref)
	base := "/projects/" + p.Ref + "/auth-config"

	type cfg struct {
		Values      map[string]any
		SecretsSet  []string `json:"secrets_set"`
		CallbackURL string   `json:"callback_url"`
		Restarted   *bool
	}
	var c cfg
	admin.must(200, "GET", base, nil, &c)
	if c.Values["site_url"] != "http://localhost:3000" || !strings.HasSuffix(c.CallbackURL, "/auth/v1/callback") {
		t.Fatalf("config = %+v", c)
	}

	_ = os.Truncate(calls, 0)
	admin.must(200, "PATCH", base, map[string]any{
		"site_url": "https://app.example.com", "external_github_enabled": true, "external_github_client_id": "id",
		"external_github_secret": "shh", "sessions_timebox": 3600,
	}, &c)
	if c.Restarted == nil || !*c.Restarted || c.Values["site_url"] != "https://app.example.com" ||
		!slices.Contains(c.SecretsSet, "external_github_secret") || c.Values["external_github_secret"] != nil {
		t.Fatalf("after patch = %+v", c)
	}
	if log, _ := os.ReadFile(calls); !strings.Contains(string(log), "up --detach --wait --no-deps --force-recreate auth") ||
		!strings.Contains(string(log), "up --detach --wait --no-deps auth-templates") {
		t.Errorf("docker calls:\n%s", log)
	}

	admin.must(400, "PATCH", base, map[string]any{"site_url": "ftp://nope"}, nil)
	admin.must(400, "PATCH", base, map[string]any{"made_up": true}, nil)
	admin.must(400, "PATCH", base, map[string]any{}, nil)

	dev := joinAs(t, env, admin, "authy", "authdev", "developer")
	dev.must(200, "GET", base, nil, nil)
	dev.must(403, "PATCH", base, map[string]any{"disable_signup": true}, nil)
	reader := joinAs(t, env, admin, "authy", "authreader", "read_only")
	reader.must(403, "PATCH", base, map[string]any{"disable_signup": true}, nil)

	// Only names reach the audit log.
	var audit struct {
		Entries []struct {
			Action   string
			Metadata map[string]any
		}
	}
	admin.must(200, "GET", "/organizations/authy/audit-logs?action=project.auth_config_updated", nil, &audit)
	if len(audit.Entries) != 1 {
		t.Fatalf("audit = %+v", audit.Entries)
	}
	if s := strings.Join(toStrings(audit.Entries[0].Metadata["settings"]), ","); s != "external_github_client_id,external_github_enabled,external_github_secret,sessions_timebox,site_url" {
		t.Errorf("audited settings = %s", s)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}
