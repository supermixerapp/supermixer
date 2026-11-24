package provision

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSameMajorVersion(t *testing.T) {
	for _, c := range []struct {
		backup, target string
		ok             bool
	}{
		{"17.6", "17.6", true},
		{"17.4", "17.6", true},
		{"15.8", "17.6", false},
		{"", "17.6", false},
	} {
		if err := SameMajorVersion(c.backup, c.target); (err == nil) != c.ok {
			t.Errorf("SameMajorVersion(%q, %q) = %v", c.backup, c.target, err)
		}
	}
}

func TestStageRestore(t *testing.T) {
	src, stack := t.TempDir(), t.TempDir()
	for _, f := range []string{"roles.sql.gz", "schema.sql.gz", "data.sql.gz", "manifest.json"} {
		if err := os.WriteFile(filepath.Join(src, f), []byte(f), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := StageRestore(src, stack); err != nil {
		t.Fatal(err)
	}
	// The staged copy outlives the backup.
	if err := os.RemoveAll(src); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(PendingRestore(stack), "data.sql.gz"))
	if err != nil || string(b) != "data.sql.gz" {
		t.Fatalf("staged data = %q, %v", b, err)
	}
	if _, err := os.Stat(PendingRestore(stack) + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("temporary folder left: %v", err)
	}
	// A missing file fails without leaving anything staged.
	other := t.TempDir()
	if err := StageRestore(t.TempDir(), other); err == nil || !strings.Contains(err.Error(), "roles.sql.gz") {
		t.Errorf("staging an empty backup = %v", err)
	}
	if _, err := os.Stat(PendingRestore(other)); !os.IsNotExist(err) {
		t.Errorf("a failed stage left %v", err)
	}
}
