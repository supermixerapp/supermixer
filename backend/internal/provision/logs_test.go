package provision

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// A stack that doesn't collect logs runs without docker-compose.logs.yml,
// and its overlay leaves Vector out; compose run by hand agrees.
func TestSetLogs(t *testing.T) {
	dir := writtenStack(t)
	for _, on := range []bool{false, true} {
		if err := SetLogs(dir, on); err != nil {
			t.Fatal(err)
		}
		env, _ := ReadEnv(dir)
		overlay, _ := os.ReadFile(filepath.Join(dir, overlayName))
		files := Compose{Layout: Layout{Dir: dir, Project: "s"}}.args()
		if LogsOf(env) != on || strings.Contains(env["COMPOSE_FILE"], logsFile) != on ||
			strings.Contains(string(overlay), "vector:") != on || slices.Contains(files, logsFile) != on {
			t.Errorf("logs %v: %s=%q COMPOSE_FILE=%q args=%v", on, LogsEnv, env[LogsEnv], env["COMPOSE_FILE"], files)
		}
		if _, err := exec.LookPath("docker"); err != nil {
			continue
		}
		cmd := exec.Command("docker", "compose", "--profile", "studio", "config", "--services")
		cmd.Dir = dir // reads COMPOSE_FILE from .env
		out, err := cmd.Output()
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				t.Fatalf("logs %v: docker compose config: %s", on, ee.Stderr)
			}
			t.Skipf("docker compose config: %v", err)
		}
		services := strings.Fields(string(out))
		if slices.Contains(services, "analytics") != on || slices.Contains(services, "vector") != on || !slices.Contains(services, "db") {
			t.Errorf("logs %v: services %v", on, services)
		}
	}
	// Stacks from before the setting collect logs.
	if !LogsOf(map[string]string{}) {
		t.Error("no setting means no logs")
	}
}

// If the overlay can't be written, the .env goes back: the stack's files
// keep agreeing with each other.
func TestSetLogsFails(t *testing.T) {
	dir := writtenStack(t)
	overlay := filepath.Join(dir, overlayName)
	if err := os.Remove(overlay); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(overlay, 0o700); err != nil { // can't be written as a file
		t.Fatal(err)
	}
	before, _ := ReadEnv(dir)
	if err := SetLogs(dir, false); err == nil {
		t.Fatal("SetLogs didn't fail")
	}
	after, _ := ReadEnv(dir)
	if !LogsOf(after) || after["COMPOSE_FILE"] != before["COMPOSE_FILE"] {
		t.Errorf("after a failure: %s=%q COMPOSE_FILE=%q (was %q)", LogsEnv, after[LogsEnv], after["COMPOSE_FILE"], before["COMPOSE_FILE"])
	}
}
