package provision

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFunctionVersions(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	deploy := func(content string) FunctionVersion {
		t.Helper()
		if err := WriteFunction(dir, "hello", []FunctionFile{{Path: "index.ts", Content: content}}, nil); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Second)
		v, _, err := RecordFunctionVersion(dir, "hello", VersionDeployed, "alice", "", now)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	v1 := deploy("one")
	if v1.Kind != VersionDeployed || v1.CreatedBy != "alice" || len(v1.Files) != 1 || v1.Files[0].Path != "index.ts" ||
		v1.Files[0].SHA256 != "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed" || v1.Size != 3 {
		t.Fatalf("v1 = %+v", v1)
	}
	v2 := deploy("two")
	if v2.SHA256 == v1.SHA256 {
		t.Fatal("different content, same hash")
	}

	// A function changed outside Supermixer is kept as found before the next change.
	if err := os.WriteFile(filepath.Join(dir, "volumes/functions/hello/index.ts"), []byte("by hand"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordFoundVersion(dir, "hello", now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	// ... but not twice, or when it matches the newest version.
	if err := RecordFoundVersion(dir, "hello", now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	list, err := ListFunctionVersions(dir, "hello")
	if err != nil || len(list) != 3 || list[0].Kind != VersionFound || list[1].ID != v2.ID || list[2].ID != v1.ID {
		t.Fatalf("versions = %+v, %v", list, err)
	}

	// Restoring puts the old files back, even after the function was deleted.
	if err := DeleteFunction(dir, "hello"); err != nil {
		t.Fatal(err)
	}
	if err := RestoreFunctionVersion(dir, "hello", v1.ID); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "volumes/functions/hello/index.ts")); string(b) != "one" {
		t.Fatalf("restored = %q", b)
	}
	_, files, other, err := ReadFunctionVersion(dir, "hello", v2.ID)
	if err != nil || len(files) != 1 || files[0].Content != "two" || len(other) != 0 {
		t.Fatalf("read v2 = %+v %v %v", files, other, err)
	}
	if _, _, _, err := ReadFunctionVersion(dir, "hello", "../../etc"); err != ErrNoVersion {
		t.Fatalf("bad id: %v", err)
	}

	// Only the newest MaxFunctionVersions are kept.
	for i := 0; i < MaxFunctionVersions+2; i++ {
		deploy(string(rune('a' + i)))
	}
	if list, _ := ListFunctionVersions(dir, "hello"); len(list) != MaxFunctionVersions {
		t.Fatalf("kept %d versions", len(list))
	}
	// Versions are outside the folder the edge runtime serves.
	if fns, _ := ListFunctions(dir); len(fns) != 1 {
		t.Fatalf("functions = %+v", fns)
	}
}

// Versions recorded within one millisecond stay in order, and a file
// Supermixer can't read doesn't stop it (listed, not kept).
func TestFunctionVersionsOrderAndUnreadable(t *testing.T) {
	dir := t.TempDir()
	if err := WriteFunction(dir, "fn", []FunctionFile{{Path: "index.ts", Content: "a"}}, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	var ids []string
	for i := 0; i < 5; i++ {
		v, _, err := RecordFunctionVersion(dir, "fn", VersionDeployed, "", "", now) // the same instant
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, v.ID)
	}
	list, _ := ListFunctionVersions(dir, "fn")
	for i, v := range list {
		if v.ID != ids[len(ids)-1-i] {
			t.Fatalf("order: %v, recorded %v", list, ids)
		}
	}

	if os.Geteuid() == 0 {
		t.Skip("root reads every file")
	}
	secret := filepath.Join(dir, "volumes/functions/fn/cache.bin")
	if err := os.WriteFile(secret, []byte("x"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(secret, 0o600) })
	if _, err := FunctionHash(dir, "fn"); err != nil {
		t.Fatalf("hash with an unreadable file: %v", err)
	}
	if err := RecordFoundVersion(dir, "fn", now); err != nil {
		t.Fatalf("found version with an unreadable file: %v", err)
	}
	list, _ = ListFunctionVersions(dir, "fn")
	if list[0].Kind != VersionFound {
		t.Fatalf("newest = %+v", list[0])
	}
	unreadable := false
	for _, f := range list[0].Files {
		unreadable = unreadable || (f.Path == "cache.bin" && f.Unreadable)
	}
	if !unreadable {
		t.Errorf("files = %+v", list[0].Files)
	}
	if _, files, other, err := ReadFunctionVersion(dir, "fn", list[0].ID); err != nil || len(files) != 1 || len(other) != 1 {
		t.Errorf("read = %v %v %v", files, other, err)
	}
	if err := RecordFoundVersion(dir, "..", now); err != nil {
		t.Errorf("an invalid name: %v", err)
	}
}
