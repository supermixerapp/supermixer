package provision

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A docker stand-in whose networks and compose commands fail as Docker does
// when its address pools are used up.
func fullDocker(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "docker")
	script := `#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls"
case "$1 $2" in
  "network prune"|"network rm") exit 0 ;;
esac
echo "Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network" >&2
exit 1
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestNetworkRoom(t *testing.T) {
	for out, want := range map[string]bool{
		"Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network": true,
		"failed to create network x_default: Error response from daemon: all predefined address pools have been fully subnetted":                 true,
		"Error response from daemon: network with name x already exists":                                                                         false,
	} {
		if PoolExhausted(out) != want {
			t.Errorf("PoolExhausted(%q) = %v", out, !want)
		}
	}

	docker := fullDocker(t)
	if err := CheckNetworkRoom(context.Background(), docker); !errors.Is(err, ErrNoNetworkRoom) {
		t.Fatalf("CheckNetworkRoom = %v", err)
	}
	calls, _ := os.ReadFile(filepath.Join(filepath.Dir(docker), "calls"))
	if !strings.Contains(string(calls), "network prune --force --filter label="+checkLabel) ||
		!strings.Contains(string(calls), "network create --label "+checkLabel+" supermixer-network-check-") {
		t.Errorf("calls:\n%s", calls)
	}

	// Compose failing for the same reason says so plainly.
	c := Compose{Docker: docker, Layout: Layout{Project: "x", Dir: t.TempDir()}}
	if err := c.Up(context.Background(), nil); !errors.Is(err, ErrNoNetworkRoom) {
		t.Fatalf("Up = %v", err)
	}

	// A Docker with room: the throwaway network is made and removed.
	ok := filepath.Join(t.TempDir(), "docker")
	if err := os.WriteFile(ok, []byte("#!/bin/sh\necho \"$*\" >> \"$(dirname \"$0\")/calls\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := CheckNetworkRoom(context.Background(), ok); err != nil {
		t.Fatal(err)
	}
	calls, _ = os.ReadFile(filepath.Join(filepath.Dir(ok), "calls"))
	if !strings.Contains(string(calls), "network rm supermixer-network-check-") {
		t.Errorf("the check's network wasn't removed:\n%s", calls)
	}
}
