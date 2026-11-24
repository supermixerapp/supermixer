package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"supermixer/internal/config"
	"supermixer/internal/provision"
)

type drainView struct {
	ID, Name, Type, URL string
	Enabled, Gzip       bool
	DatadogSite         string `json:"datadog_site"`
	APIKeySet           bool   `json:"api_key_set"`
	Headers             []struct {
		Name     string
		ValueSet bool `json:"value_set"`
	}
}

func TestLogDrains(t *testing.T) {
	stacks := t.TempDir()
	calls := filepath.Join(t.TempDir(), "docker.log")
	t.Setenv("FAKE_DOCKER_LOG", calls)
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.BackupsDir = t.TempDir()
		c.Provisioning.Docker = fake
		c.Provisioning.APIPorts, c.Provisioning.DBPorts, c.Provisioning.PoolerPorts = "8280-8281", "54480-54481", "64480-64481"
	})
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Dr"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/dr/projects/new-stack", map[string]string{"name": "x"}, &p)
	waitStack(t, admin, p.Ref)
	base := "/projects/" + p.Ref + "/log-drains"
	dir := filepath.Join(stacks, p.Ref)
	cfg := func() string {
		b, _ := os.ReadFile(filepath.Join(dir, "volumes/logs/drains/drains.yml"))
		return string(b)
	}

	var list struct{ Drains []drainView }
	admin.must(200, "GET", base, nil, &list)
	if len(list.Drains) != 0 {
		t.Fatalf("drains = %+v", list)
	}

	// Add one: checked with Vector, saved, Vector recreated.
	_ = os.Truncate(calls, 0)
	var d drainView
	admin.must(201, "POST", base, map[string]any{"name": "Collector", "type": "http", "url": "https://logs.example.com/in",
		"gzip": true, "headers": []map[string]string{{"name": "Authorization", "value": "Bearer s3cret"}}}, &d)
	if !d.Enabled || len(d.Headers) != 1 || !d.Headers[0].ValueSet || d.URL != "https://logs.example.com/in" {
		t.Fatalf("created = %+v", d)
	}
	log, _ := os.ReadFile(calls)
	for _, want := range []string{"run --rm --no-deps -T --entrypoint vector vector validate --no-environment", "--force-recreate vector"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("docker calls lack %q:\n%s", want, log)
		}
	}
	if !strings.Contains(cfg(), "supermixer_drain_sink_"+d.ID) || !strings.Contains(cfg(), "Bearer s3cret") {
		t.Errorf("config:\n%s", cfg())
	}

	// The list never shows secrets.
	res := admin.raw("GET", base)
	body := make([]byte, 4096)
	n, _ := res.Body.Read(body)
	res.Body.Close()
	if strings.Contains(string(body[:n]), "s3cret") {
		t.Error("the list shows a header's value")
	}

	// Changing it without the header's value keeps the value.
	admin.must(200, "PATCH", base+"/"+d.ID, map[string]any{"name": "Collector", "type": "http", "url": "https://logs.example.com/v2",
		"headers": []map[string]string{{"name": "Authorization"}}}, &d)
	if got, _ := provision.ReadDrains(dir); got[0].Headers[0].Value != "Bearer s3cret" || got[0].URL != "https://logs.example.com/v2" || got[0].Gzip {
		t.Errorf("after the change: %+v", got)
	}

	// A configuration Vector refuses isn't saved.
	t.Setenv("FAKE_DOCKER_FAIL", "run")
	admin.must(400, "POST", base, map[string]any{"name": "DD", "type": "datadog", "datadog_site": "datadoghq.eu", "api_key": "k"}, nil)
	t.Setenv("FAKE_DOCKER_FAIL", "")
	if got, _ := provision.ReadDrains(dir); len(got) != 1 {
		t.Errorf("drains after a refused one = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "volumes/logs/drains/next.yml")); !os.IsNotExist(err) {
		t.Error("the refused configuration was left staged")
	}

	// Bad input; roles.
	admin.must(400, "POST", base, map[string]any{"name": "x", "type": "http", "url": "ftp://x"}, nil)
	admin.must(400, "POST", base, map[string]any{"name": "x", "type": "datadog", "datadog_site": "datadoghq.eu"}, nil)
	dev := joinAs(t, env, admin, "dr", "drdev", "developer")
	dev.must(200, "GET", base, nil, nil)
	dev.must(403, "POST", base, map[string]any{"name": "x", "type": "http", "url": "https://x/"}, nil)

	// Datadog keeps its key when left out; disabling removes the sink.
	var dd drainView
	admin.must(201, "POST", base, map[string]any{"name": "DD", "type": "datadog", "datadog_site": "datadoghq.eu", "api_key": "dd-key"}, &dd)
	admin.must(200, "PATCH", base+"/"+dd.ID, map[string]any{"name": "DD", "type": "datadog", "datadog_site": "datadoghq.com", "enabled": false}, &dd)
	if !dd.APIKeySet || dd.Enabled || strings.Contains(cfg(), dd.ID) {
		t.Errorf("disabled datadog drain = %+v\n%s", dd, cfg())
	}

	admin.must(204, "DELETE", base+"/"+d.ID, nil, nil)
	admin.must(404, "DELETE", base+"/"+d.ID, nil, nil)
	if strings.Contains(cfg(), d.ID) {
		t.Error("a deleted drain is still configured")
	}

	var audit struct{ Entries []struct{ Action string } }
	admin.must(200, "GET", "/organizations/dr/audit-logs", nil, &audit)
	got := map[string]int{}
	for _, e := range audit.Entries {
		got[e.Action]++
	}
	if got["project.log_drain_created"] != 2 || got["project.log_drain_updated"] != 2 || got["project.log_drain_deleted"] != 1 {
		t.Errorf("audit = %v", got)
	}
}
