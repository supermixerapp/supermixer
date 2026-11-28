// Package datadir prepares Supermixer's data folder for the container
// install (supermixer init): the folders it writes to, owned by the user it
// runs as, and the secrets it needs, generated once.
//
//	<dir>/secrets/encryption_key        Supermixer's encryption key
//	<dir>/secrets/db_password           its database's password
//	<dir>/secrets/postgres/password     the same password, for the database container
//	<dir>/tls                           the certificate, copied by the certbot hook
//	<dir>/stacks, <dir>/backups         created stacks and their backups
package datadir

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Options says where and for whom.
type Options struct {
	Dir string
	// UID and GID are the user Supermixer runs as.
	UID, GID int
	// PostgresUID and PostgresGID are the database container's user
	// (70 in the postgres Alpine image).
	PostgresUID, PostgresGID int
}

// Report says what Prepare made, for its log.
type Report struct {
	Created []string // folders and secrets that didn't exist
}

// Prepare creates what's missing and sets owners and modes on the folders
// and secrets it manages; it never replaces a secret or looks inside
// stacks and backups. Running it again changes nothing.
func Prepare(o Options) (Report, error) {
	var r Report
	if err := os.MkdirAll(o.Dir, 0o755); err != nil {
		return r, err
	}
	own := func(path string, uid, gid int, mode fs.FileMode) error {
		if err := os.Chown(path, uid, gid); err != nil {
			return err
		}
		return os.Chmod(path, mode)
	}
	dir := func(name string, uid, gid int) (string, error) {
		path := filepath.Join(o.Dir, name)
		if err := os.Mkdir(path, 0o700); err == nil {
			r.Created = append(r.Created, path)
		} else if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
		return path, own(path, uid, gid, 0o700)
	}
	secret := func(path, value string, uid, gid int, mode fs.FileMode) error {
		if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
			if err := os.WriteFile(path, []byte(value+"\n"), mode); err != nil {
				return err
			}
			r.Created = append(r.Created, path)
		} else if err != nil {
			return err
		}
		return own(path, uid, gid, mode)
	}

	for _, name := range []string{"secrets", "tls", "stacks", "backups"} {
		if _, err := dir(name, o.UID, o.GID); err != nil {
			return r, err
		}
	}
	pgDir, err := dir(filepath.Join("secrets", "postgres"), o.PostgresUID, o.PostgresGID)
	if err != nil {
		return r, err
	}

	key, err := random(32)
	if err != nil {
		return r, err
	}
	if err := secret(filepath.Join(o.Dir, "secrets", "encryption_key"), base64.StdEncoding.EncodeToString(key), o.UID, o.GID, 0o600); err != nil {
		return r, err
	}

	// One password, in two files: each container reads only its own.
	pwPath := filepath.Join(o.Dir, "secrets", "db_password")
	pw, err := random(24)
	if err != nil {
		return r, err
	}
	if err := secret(pwPath, hex.EncodeToString(pw), o.UID, o.GID, 0o600); err != nil {
		return r, err
	}
	b, err := os.ReadFile(pwPath)
	if err != nil {
		return r, err
	}
	current := strings.TrimSpace(string(b))
	pgPath := filepath.Join(pgDir, "password")
	if b, err := os.ReadFile(pgPath); err == nil && strings.TrimSpace(string(b)) != current {
		return r, fmt.Errorf("%s and %s differ; delete one of them only if the database has never started", pwPath, pgPath)
	}
	if err := secret(pgPath, current, o.PostgresUID, o.PostgresGID, 0o400); err != nil {
		return r, err
	}
	return r, nil
}

func random(n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return b, err
}
