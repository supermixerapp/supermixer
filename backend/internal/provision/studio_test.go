package provision

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// provisioning.studio: a stack runs Supabase Studio only if its .env says so.
func TestStudioOverlay(t *testing.T) {
	dir := writtenStack(t)
	overlayOf := func(on string) string {
		t.Helper()
		if err := UpdateEnv(dir, map[string]string{StudioEnv: on}); err != nil {
			t.Fatal(err)
		}
		if err := RefreshOverlay(dir); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(filepath.Join(dir, overlayName))
		return string(b)
	}
	if o := overlayOf("false"); !strings.Contains(o, `profiles: ["studio"]`) || !strings.Contains(o, "depends_on: !reset []") {
		t.Errorf("off: overlay doesn't leave Studio out:\n%s", o)
	}
	if o := overlayOf("true"); strings.Contains(o, "profiles:") || strings.Contains(o, "!reset") {
		t.Errorf("on: overlay leaves Studio out:\n%s", o)
	}

	// As Docker Compose reads it, if there's a docker CLI here.
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("no docker CLI")
	}
	for _, on := range []string{"false", "true"} {
		overlayOf(on)
		run := func(args ...string) []byte {
			cmd := exec.Command("docker", append([]string{"compose"}, args...)...)
			cmd.Dir = dir
			out, err := cmd.Output()
			if err != nil {
				t.Skipf("docker compose: %v", err)
			}
			return out
		}
		services := strings.Fields(string(run("config", "--services")))
		var cfg struct {
			Services map[string]struct {
				DependsOn map[string]any `json:"depends_on"`
			} `json:"services"`
		}
		_ = json.Unmarshal(run("config", "--format", "json"), &cfg)
		_, gatewayWaits := cfg.Services["api-gw"].DependsOn["studio"]
		if want := on == "true"; slices.Contains(services, "studio") != want || gatewayWaits != want {
			t.Errorf("studio %s: listed %v, gateway waits for it %v", on, slices.Contains(services, "studio"), gatewayWaits)
		}
		// Named with its profile, it's still there to remove.
		if !slices.Contains(strings.Fields(string(run("--profile", "studio", "config", "--services"))), "studio") {
			t.Errorf("studio %s: not found with its profile", on)
		}
	}
}

func TestSetStudio(t *testing.T) {
	dir := writtenStack(t)
	calls := filepath.Join(t.TempDir(), "calls")
	docker := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(docker, []byte("#!/bin/sh\necho \"$*\" >> "+calls+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := Compose{Docker: docker, Layout: Layout{Dir: dir, Project: "s"}}
	for _, on := range []bool{false, true} {
		if err := c.SetStudio(context.Background(), nil, on); err != nil {
			t.Fatal(err)
		}
		env, _ := ReadEnv(dir)
		if StudioOf(env) != on {
			t.Errorf("SetStudio(%v): .env says %q", on, env[StudioEnv])
		}
	}
	log, _ := os.ReadFile(calls)
	lines := strings.Split(strings.TrimSpace(string(log)), "\n")
	if len(lines) != 2 || !strings.HasSuffix(lines[0], "--profile studio rm --stop --force studio") || !strings.HasSuffix(lines[1], "up --detach --no-deps studio") {
		t.Errorf("docker calls:\n%s", log)
	}
}

// A failed change goes back, so it's tried again.
func TestSetStudioFails(t *testing.T) {
	dir := writtenStack(t)
	docker := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(docker, []byte("#!/bin/sh\necho nope >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := Compose{Docker: docker, Layout: Layout{Dir: dir, Project: "s"}}
	for _, tc := range []struct{ before, want string }{{"", "true"}, {"true", "true"}, {"false", "false"}} {
		if tc.before == "" {
			raw, _ := os.ReadFile(filepath.Join(dir, ".env"))
			var kept []string
			for _, l := range strings.Split(string(raw), "\n") {
				if !strings.HasPrefix(l, StudioEnv+"=") {
					kept = append(kept, l)
				}
			}
			_ = os.WriteFile(filepath.Join(dir, ".env"), []byte(strings.Join(kept, "\n")), 0o600)
		} else if err := UpdateEnv(dir, map[string]string{StudioEnv: tc.before}); err != nil {
			t.Fatal(err)
		}
		if err := c.SetStudio(context.Background(), nil, tc.want != "true"); err == nil {
			t.Fatal("SetStudio didn't fail")
		}
		env, _ := ReadEnv(dir)
		if env[StudioEnv] != tc.want {
			t.Errorf("before %q: after a failure, %s = %q, want %q", tc.before, StudioEnv, env[StudioEnv], tc.want)
		}
		overlay, _ := os.ReadFile(filepath.Join(dir, overlayName))
		if strings.Contains(string(overlay), "profiles:") != (tc.want == "false") {
			t.Errorf("before %q: overlay doesn't match %s", tc.before, tc.want)
		}
	}
}

// Pausing, deleting and listing include Studio, even when it's left out.
func TestComposeIncludesStudio(t *testing.T) {
	dir := writtenStack(t)
	calls := filepath.Join(t.TempDir(), "calls")
	docker := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(docker, []byte("#!/bin/sh\necho \"$*\" >> "+calls+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := Compose{Docker: docker, Layout: Layout{Dir: dir, Project: "s"}}
	ctx := context.Background()
	_ = c.Stop(ctx, nil)
	_ = c.Down(ctx, nil)
	_, _ = c.PS(ctx)
	log, _ := os.ReadFile(calls)
	for _, want := range []string{"--profile studio stop", "--profile studio down --volumes", "--profile studio ps --all"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("no %q in:\n%s", want, log)
		}
	}
}

func TestComposeAtLeast(t *testing.T) {
	for v, want := range map[string]bool{
		"2.24.0": true, "2.24": true, "2.29.1": true, "2.30.0-desktop.1": true, "5.7.1": true, "3.0.0": true,
		"2.23.3": false, "2.9.0": false, "1.29.2": false, "": false,
	} {
		if ComposeAtLeast(v, MinCompose) != want {
			t.Errorf("ComposeAtLeast(%q) = %v", v, !want)
		}
	}
}

func TestStudioRunning(t *testing.T) {
	for _, tc := range []struct {
		services        []Service
		exists, running bool
	}{
		{nil, false, false},
		{[]Service{{Service: "db", State: "running"}}, false, false},
		{[]Service{{Service: "studio", State: "exited"}}, true, false},
		{[]Service{{Service: "db", State: "running"}, {Service: "studio", State: "running"}}, true, true},
	} {
		if e, r := StudioRunning(tc.services); e != tc.exists || r != tc.running {
			t.Errorf("%+v: %v %v", tc.services, e, r)
		}
	}
}
