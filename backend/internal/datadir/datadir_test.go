package datadir

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepare(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "supermixer")
	uid, gid := os.Getuid(), os.Getgid()
	o := Options{Dir: dir, UID: uid, GID: gid, PostgresUID: uid, PostgresGID: gid}

	r, err := Prepare(o)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Created) != 8 { // 5 folders, 3 secrets
		t.Fatalf("created %v", r.Created)
	}
	for _, name := range []string{"secrets", "tls", "stacks", "backups", "secrets/postgres"} {
		if fi, err := os.Stat(filepath.Join(dir, name)); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("%s: %v %v", name, fi.Mode(), err)
		}
	}
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	if key, err := base64.StdEncoding.DecodeString(read("secrets/encryption_key")); err != nil || len(key) != 32 {
		t.Errorf("encryption key: %d bytes, %v", len(key), err)
	}
	pw := read("secrets/db_password")
	if len(pw) != 48 || read("secrets/postgres/password") != pw {
		t.Errorf("passwords: %q, %q", pw, read("secrets/postgres/password"))
	}
	if fi, _ := os.Stat(filepath.Join(dir, "secrets/postgres/password")); fi.Mode().Perm() != 0o400 {
		t.Errorf("postgres password mode %v", fi.Mode())
	}

	// Again: nothing new, nothing replaced, modes put back.
	key := read("secrets/encryption_key")
	_ = os.Chmod(filepath.Join(dir, "tls"), 0o755)
	r, err = Prepare(o)
	if err != nil || len(r.Created) != 0 {
		t.Fatalf("second run: %v %v", r.Created, err)
	}
	if read("secrets/encryption_key") != key || read("secrets/db_password") != pw {
		t.Error("a secret was replaced")
	}
	if fi, _ := os.Stat(filepath.Join(dir, "tls")); fi.Mode().Perm() != 0o700 {
		t.Errorf("tls mode not put back: %v", fi.Mode())
	}

	// The two copies of the password must agree.
	_ = os.Chmod(filepath.Join(dir, "secrets/postgres/password"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "secrets/postgres/password"), []byte("other\n"), 0o600)
	if _, err := Prepare(o); err == nil || !strings.Contains(err.Error(), "differ") {
		t.Fatalf("differing passwords: %v", err)
	}
}
