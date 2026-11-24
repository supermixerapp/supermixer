package provision

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateDrain(t *testing.T) {
	ok := LogDrain{ID: "abcd1234", Name: "Logs", Type: "http", Enabled: true, URL: "https://logs.example.com/in",
		Headers: []Header{{"Authorization", "Bearer x"}}}
	if err := ValidateDrain(ok); err != nil {
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*LogDrain){
		"bad id":          func(d *LogDrain) { d.ID = "../x" },
		"no name":         func(d *LogDrain) { d.Name = " " },
		"bad type":        func(d *LogDrain) { d.Type = "s3" },
		"ftp url":         func(d *LogDrain) { d.URL = "ftp://x/" },
		"login in url":    func(d *LogDrain) { d.URL = "https://u:p@x/" },
		"quote in url":    func(d *LogDrain) { d.URL = `https://x/"` },
		"bad header name": func(d *LogDrain) { d.Headers = []Header{{"X Bad", "v"}} },
		"header twice":    func(d *LogDrain) { d.Headers = []Header{{"X-A", "1"}, {"x-a", "2"}} },
		"header newline":  func(d *LogDrain) { d.Headers = []Header{{"X-A", "1\nX-B: 2"}} },
		"datadog no key":  func(d *LogDrain) { d.Type, d.DatadogSite = "datadog", "datadoghq.eu" },
		"datadog site":    func(d *LogDrain) { d.Type, d.DatadogSite, d.APIKey = "datadog", "example.com", "k" },
	} {
		d := ok
		d.Headers = append([]Header(nil), ok.Headers...)
		mut(&d)
		if err := ValidateDrain(d); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestDrainsConfig(t *testing.T) {
	l := Layout{Dir: filepath.Join(t.TempDir(), "s"), Project: "supermixer-s"}
	s, _ := GenerateSecrets(time.Now())
	if err := WriteStack(l, s.Env()); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(l.Dir, "volumes/logs/drains/drains.yml")
	if b, err := os.ReadFile(cfg); err != nil || strings.Contains(string(b), "sinks") {
		t.Fatalf("a new stack's drains config = %q, %v", b, err)
	}
	drains := []LogDrain{
		{ID: "aaaa1111", Name: "Web", Type: "http", Enabled: true, URL: "https://h.example/in", Gzip: true,
			Headers: []Header{{"Authorization", "Bearer pa$$word"}}},
		{ID: "bbbb2222", Name: "Loki", Type: "loki", Enabled: true, URL: "http://loki:3100"},
		{ID: "cccc3333", Name: "DD", Type: "datadog", Enabled: true, DatadogSite: "datadoghq.eu", APIKey: "dd-key"},
		{ID: "dddd4444", Name: "Off", Type: "http", Enabled: false, URL: "https://off.example/"},
	}
	if err := StageDrains(l.Dir, l.Project, drains); err != nil {
		t.Fatal(err)
	}
	staged, _ := os.ReadFile(filepath.Join(l.Dir, "volumes/logs/drains/next.yml"))
	for _, want := range []string{"supermixer_drain_sink_aaaa1111:", "type: http", "compression: gzip", `"Bearer pa$$$$word"`,
		"type: loki", `service: "{{ supabase_service }}"`, "type: datadog_logs", `default_api_key: "dd-key"`,
		"supermixer_drain_auth_logs:", `.supabase_project = "supermixer-s"`} {
		if !strings.Contains(string(staged), want) {
			t.Errorf("staged config lacks %q:\n%s", want, staged)
		}
	}
	if strings.Contains(string(staged), "dddd4444") {
		t.Error("a disabled drain was rendered")
	}
	if fi, _ := os.Stat(filepath.Join(l.Dir, "volumes/logs/drains/next.yml")); fi.Mode().Perm() != 0o600 {
		t.Errorf("staged config mode %v", fi.Mode())
	}
	// Discarding leaves the config in use alone.
	DiscardDrains(l.Dir)
	if got, _ := ReadDrains(l.Dir); len(got) != 0 {
		t.Errorf("drains after discarding = %v", got)
	}
	if err := StageDrains(l.Dir, l.Project, drains); err != nil {
		t.Fatal(err)
	}
	if err := CommitDrains(l.Dir, drains); err != nil {
		t.Fatal(err)
	}
	if got, _ := ReadDrains(l.Dir); len(got) != 4 || got[0].Headers[0].Value != "Bearer pa$$word" {
		t.Errorf("drains = %+v", got)
	}
	if b, _ := os.ReadFile(cfg); string(b) != string(staged) {
		t.Error("committing didn't put the staged config in place")
	}
	if err := StageDrains(l.Dir, l.Project, []LogDrain{{ID: "x", Name: "bad"}}); err == nil {
		t.Error("an invalid drain was staged")
	}

	// Compose runs Vector with both configs.
	if _, err := exec.LookPath("docker"); err != nil {
		return
	}
	cmd := exec.Command("docker", "compose", "config", "--format", "json")
	cmd.Dir = l.Dir
	out, err := cmd.Output()
	if err != nil {
		t.Skipf("docker compose config: %v", err)
	}
	var c struct {
		Services map[string]struct {
			Command []string `json:"command"`
			Volumes []struct{ Source, Target string }
		} `json:"services"`
	}
	if err := json.Unmarshal(out, &c); err != nil {
		t.Fatal(err)
	}
	v := c.Services["vector"]
	if strings.Join(v.Command, " ") != "--config /etc/vector/vector.yml --config /etc/vector/drains/drains.yml" {
		t.Errorf("vector command = %v", v.Command)
	}
	mounted := false
	for _, m := range v.Volumes {
		mounted = mounted || (m.Target == "/etc/vector/drains" && strings.HasSuffix(m.Source, "volumes/logs/drains"))
	}
	if !mounted {
		t.Errorf("vector volumes = %+v", v.Volumes)
	}
}
