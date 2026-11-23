package httpapi

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

func TestEdgeFunctionsOfCreatedStacks(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8220-8221", "54420-54421", "64420-64421"
	})
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Fns"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/fns/projects/new-stack", map[string]string{"name": "Fns"}, &p)
	ref := p.Ref
	waitStack(t, admin, ref)
	base := "/projects/" + ref

	// Starting set up the functions' database login, inside the db container.
	if log, _ := os.ReadFile(calls); !strings.Contains(string(log), "exec -T db psql -U supabase_admin") {
		t.Errorf("no functions_user setup in docker calls:\n%s", log)
	}
	created, _ := provision.ReadEnv(filepath.Join(stacks, ref))
	if !strings.HasPrefix(created["FUNCTIONS_DB_LOGIN"], "functions_user:") {
		t.Errorf("FUNCTIONS_DB_LOGIN = %q", created["FUNCTIONS_DB_LOGIN"])
	}

	// No example placeholder that is a stack secret survives into a created stack.
	notStackSecrets := map[string]bool{"OPENAI_API_KEY": true, "CERTBOT_EMAIL": true, "PROXY_DOMAIN": true}
	placeholder := regexp.MustCompile(`(?i)your-|insecure|secret1234|supabaserealtime|^eyJ|fake_`)
	for k, example := range provision.ExampleEnv() {
		// SMTP_* configure an outside mail server (Auth settings, Stage 4.3).
		if notStackSecrets[k] || strings.HasPrefix(k, "SMTP_") || example == "" {
			continue
		}
		looksSecret := placeholder.MatchString(example) || regexp.MustCompile(`(?i)PASSWORD|SECRET|_KEY$|TOKEN`).MatchString(k)
		if looksSecret && created[k] == example {
			t.Errorf("%s still has the example's value", k)
		}
	}

	// The template's example function is there.
	var list []struct {
		Name, URL  string
		Files      int
		Entrypoint *string
	}
	admin.must(200, "GET", base+"/functions", nil, &list)
	if len(list) != 1 || list[0].Name != "hello" || list[0].Entrypoint == nil || !strings.HasSuffix(list[0].URL, "/functions/v1/hello") {
		t.Fatalf("functions = %+v", list)
	}

	// Deploy a new one; the running stack's functions service is recreated.
	_ = os.Truncate(calls, 0)
	files := []map[string]string{{"path": "index.ts", "content": "Deno.serve(() => new Response('hi'))\n"}, {"path": "lib/x.ts", "content": "export {}\n"}}
	var change struct {
		Restarted bool
		Function  struct {
			Name  string
			Files int
		}
	}
	admin.must(200, "PUT", base+"/functions/greet", map[string]any{"files": files}, &change)
	if !change.Restarted || change.Function.Name != "greet" || change.Function.Files != 2 {
		t.Fatalf("deploy = %+v", change)
	}
	log, _ := os.ReadFile(calls)
	if !strings.Contains(string(log), "up --detach --wait --no-deps --force-recreate functions") {
		t.Errorf("docker calls:\n%s", log)
	}

	// A file that isn't text survives a redeploy that keeps it.
	fnDir := filepath.Join(stacks, ref, "volumes/functions/greet")
	if err := os.WriteFile(filepath.Join(fnDir, "logo.png"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatal(err)
	}
	var detail struct {
		Files      []struct{ Path, Content string }
		OtherFiles []string `json:"other_files"`
	}
	admin.must(200, "GET", base+"/functions/greet", nil, &detail)
	if len(detail.Files) != 2 || len(detail.OtherFiles) != 1 || detail.OtherFiles[0] != "logo.png" {
		t.Fatalf("detail = %+v", detail)
	}
	// A dot file is kept too, though it couldn't be created in the editor.
	if err := os.WriteFile(filepath.Join(fnDir, ".npmrc"), []byte("registry=x"), 0o644); err != nil {
		t.Fatal(err)
	}
	admin.must(200, "GET", base+"/functions/greet", nil, &detail)
	admin.must(200, "PUT", base+"/functions/greet", map[string]any{"files": files[:1], "keep": detail.OtherFiles}, nil)
	if _, err := os.Stat(filepath.Join(fnDir, ".npmrc")); err != nil {
		t.Error("kept dot file is gone")
	}
	if _, err := os.Stat(filepath.Join(fnDir, "logo.png")); err != nil {
		t.Error("kept file is gone")
	}
	if _, err := os.Stat(filepath.Join(fnDir, "lib/x.ts")); err == nil {
		t.Error("a file left out of the deploy is still there")
	}

	// Bad deploys change nothing.
	admin.must(400, "PUT", base+"/functions/main", map[string]any{"files": files}, nil)
	admin.must(400, "PUT", base+"/functions/secrets", map[string]any{"files": files}, nil)
	admin.must(400, "PUT", base+"/functions/greet", map[string]any{"files": []map[string]string{{"path": "../../x.ts", "content": ""}}}, nil)
	admin.must(400, "PUT", base+"/functions/greet", map[string]any{"files": []map[string]string{{"path": "util.ts", "content": ""}}}, nil)
	admin.must(404, "GET", base+"/functions/nope", nil, nil)

	// Secrets: names and digests only, never values.
	var secrets struct {
		Restarted bool
		Secrets   []struct{ Name, Digest string }
	}
	admin.must(200, "PUT", base+"/function-secrets", map[string]any{"secrets": []map[string]string{{"name": "STRIPE_KEY", "value": "sk_test_$abc\n"}}}, &secrets)
	if !secrets.Restarted || len(secrets.Secrets) != 1 || len(secrets.Secrets[0].Digest) != 64 {
		t.Fatalf("set = %+v", secrets)
	}
	admin.must(400, "PUT", base+"/function-secrets", map[string]any{"secrets": []map[string]string{{"name": "SUPABASE_URL", "value": "x"}}}, nil)
	admin.must(400, "PUT", base+"/function-secrets", map[string]any{"secrets": []map[string]string{{"name": "K", "value": "a\u0000b"}}}, nil)
	envFile, _ := os.ReadFile(filepath.Join(stacks, ref, "functions.env"))
	if !strings.Contains(string(envFile), `STRIPE_KEY="sk_test_$$abc\n"`) {
		t.Errorf("functions.env = %s", envFile)
	}
	overlay, _ := os.ReadFile(filepath.Join(stacks, ref, "supermixer.yml"))
	if !strings.Contains(string(overlay), "./functions.env") {
		t.Error("overlay doesn't give functions the secrets")
	}
	var listed []struct{ Name, Digest string }
	admin.must(200, "GET", base+"/function-secrets", nil, &listed)
	if len(listed) != 1 || listed[0].Digest != secrets.Secrets[0].Digest {
		t.Fatalf("listed = %+v", listed)
	}

	// Roles: Developers deploy; Read-Only members see code but not secrets.
	dev := joinAs(t, env, admin, "fns", "fndev", "developer")
	dev.must(200, "PUT", base+"/functions/dev-fn", map[string]any{"files": files[:1]}, nil)
	dev.must(200, "GET", base+"/function-secrets", nil, nil)
	reader := joinAs(t, env, admin, "fns", "fnreader", "read_only")
	reader.must(200, "GET", base+"/functions/greet", nil, nil)
	reader.must(403, "PUT", base+"/functions/greet", map[string]any{"files": files}, nil)
	reader.must(403, "GET", base+"/function-secrets", nil, nil)
	reader.must(403, "DELETE", base+"/functions/greet", nil, nil)

	// How functions reach the database: Owners and Administrators choose.
	var settings struct {
		DatabaseAccess string `json:"database_access"`
		Restarted      bool
	}
	admin.must(200, "GET", base+"/function-settings", nil, &settings)
	if settings.DatabaseAccess != "service_role" {
		t.Fatalf("settings = %+v", settings)
	}
	dev.must(403, "PUT", base+"/function-settings", map[string]string{"database_access": "postgres"}, nil)
	reader.must(200, "GET", base+"/function-settings", nil, nil)
	admin.must(400, "PUT", base+"/function-settings", map[string]string{"database_access": "root"}, nil)
	admin.must(200, "PUT", base+"/function-settings", map[string]string{"database_access": "postgres"}, &settings)
	if settings.DatabaseAccess != "postgres" || !settings.Restarted {
		t.Fatalf("set = %+v", settings)
	}
	created, _ = provision.ReadEnv(filepath.Join(stacks, ref))
	if created["FUNCTIONS_DB_LOGIN"] != "postgres:"+created["POSTGRES_PASSWORD"] {
		t.Error("FUNCTIONS_DB_LOGIN isn't postgres's")
	}
	admin.must(200, "PUT", base+"/function-settings", map[string]string{"database_access": "service_role"}, nil)

	// Paused: saved, applied at the next start.
	admin.must(202, "POST", base+"/stack/stop", nil, nil)
	waitStack(t, admin, ref)
	admin.must(200, "DELETE", base+"/function-secrets", map[string]any{"names": []string{"STRIPE_KEY"}}, &secrets)
	if secrets.Restarted || len(secrets.Secrets) != 0 {
		t.Fatalf("delete secrets while paused = %+v", secrets)
	}
	admin.must(200, "DELETE", base+"/functions/greet", nil, &change)
	if change.Restarted {
		t.Error("restarted a paused stack's functions")
	}
	admin.must(404, "DELETE", base+"/functions/greet", nil, nil)

	// A failed restart says so, but the change is kept and audited.
	admin.must(202, "POST", base+"/stack/start", nil, nil)
	waitStack(t, admin, ref)
	t.Setenv("FAKE_DOCKER_FAIL", "up")
	admin.must(502, "PUT", base+"/functions/greet", map[string]any{"files": files[:1]}, nil)
	if _, err := os.Stat(filepath.Join(fnDir, "index.ts")); err != nil {
		t.Error("the deploy wasn't kept")
	}

	var audit struct{ Entries []struct{ Action string } }
	admin.must(200, "GET", "/organizations/fns/audit-logs", nil, &audit)
	got := map[string]int{}
	for _, e := range audit.Entries {
		got[e.Action]++
	}
	if got["project.function_settings_updated"] != 2 {
		t.Errorf("settings changes audited %d times", got["project.function_settings_updated"])
	}
	if got["project.function_deployed"] != 4 || got["project.function_deleted"] != 1 || got["project.function_secrets_set"] != 1 || got["project.function_secrets_deleted"] != 1 {
		t.Errorf("audit = %v", got)
	}
}

func TestEdgeFunctionsNeedACreatedStack(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Linked"}, nil)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/linked/projects", map[string]any{"name": "P", "connection": connectionFor(t, "http://127.0.0.1:9", env.dbURL)}, &p)
	ref := p.Ref
	admin.must(409, "GET", "/projects/"+ref+"/functions", nil, nil)
	admin.must(409, "PUT", "/projects/"+ref+"/function-secrets", map[string]any{"secrets": []map[string]string{{"name": "A", "value": "b"}}}, nil)
}
