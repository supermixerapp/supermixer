package provision

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"time"
	"unicode/utf8"
)

// Each deploy of a function is kept, so it can be inspected afterwards (what
// ran, with hashes for the audit log) and rolled back. Versions live in the
// stack's functions-history folder, outside volumes/functions, so the edge
// runtime never sees them: functions-history/<name>/<version id>/ holds
// version.json and files/, a copy of the function's folder.

const functionHistoryDir = "functions-history"

// MaxFunctionVersions is how many versions of each function are kept.
const MaxFunctionVersions = 10

// Kinds of function version.
const (
	// VersionDeployed is a deploy from Supermixer.
	VersionDeployed = "deployed"
	// VersionRestored is an earlier version put back.
	VersionRestored = "restored"
	// VersionFound is the function as Supermixer found it before changing
	// it, when that's not its last recorded version: deployed before
	// versions were kept, or changed outside Supermixer.
	VersionFound = "found"
)

// FunctionVersion describes one kept version of a function.
type FunctionVersion struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
	// CreatedBy is the user who deployed or restored it; empty for found versions.
	CreatedBy string `json:"created_by,omitempty"`
	// RestoredFrom is the version a restored one copies.
	RestoredFrom string `json:"restored_from,omitempty"`
	// SHA256 identifies the whole function: the hash of its files' paths and hashes.
	SHA256 string     `json:"sha256"`
	Files  []FileHash `json:"files"`
	Size   int64      `json:"size"`
}

// FileHash is one file of a version. A symbolic link's hash is of its target.
type FileHash struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Link   string `json:"link,omitempty"`
	// Unreadable marks a file Supermixer couldn't read (one a container's
	// user wrote, on Linux bind mounts): listed, but not hashed or kept.
	Unreadable bool `json:"unreadable,omitempty"`
}

var versionID = regexp.MustCompile(`^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{6}$`)

func historyRoot(stackDir, name string) string {
	return filepath.Join(stackDir, functionHistoryDir, name)
}

// hashFunction lists a function folder's files with their hashes. Files
// and folders it can't read are listed as unreadable rather than failing.
func hashFunction(dir string) ([]FileHash, string, int64, error) {
	var files []FileHash
	var total int64
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		rel, _ := filepath.Rel(dir, p)
		f := FileHash{Path: filepath.ToSlash(rel)}
		if err != nil {
			if !errors.Is(err, fs.ErrPermission) || p == dir {
				return err
			}
			f.Unreadable, f.SHA256 = true, "unreadable"
			files = append(files, f)
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			sum := sha256.Sum256([]byte(target))
			f.SHA256, f.Link = hex.EncodeToString(sum[:]), target
		case d.Type().IsRegular():
			b, err := os.ReadFile(p)
			if errors.Is(err, fs.ErrPermission) {
				f.Unreadable, f.SHA256 = true, "unreadable"
				break
			}
			if err != nil {
				return err
			}
			sum := sha256.Sum256(b)
			f.SHA256, f.Size = hex.EncodeToString(sum[:]), int64(len(b))
			total += f.Size
		default:
			return nil
		}
		files = append(files, f)
		return nil
	})
	if err != nil {
		return nil, "", 0, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	h := sha256.New()
	for _, f := range files {
		fmt.Fprintf(h, "%s\x00%s\n", f.Path, f.SHA256)
	}
	return files, hex.EncodeToString(h.Sum(nil)), total, nil
}

// FunctionHash is a deployed function's hash, as its version's would be.
func FunctionHash(stackDir, name string) (string, error) {
	if err := ValidFunctionName(name); err != nil {
		return "", ErrNoFunction
	}
	_, sum, _, err := hashFunction(filepath.Join(functionsRoot(stackDir), name))
	return sum, err
}

// ListFunctionVersions lists a function's kept versions, newest first. A
// deleted function's versions are kept too.
func ListFunctionVersions(stackDir, name string) ([]FunctionVersion, error) {
	if err := ValidFunctionName(name); err != nil {
		return nil, ErrNoFunction
	}
	entries, err := os.ReadDir(historyRoot(stackDir, name))
	if errors.Is(err, fs.ErrNotExist) {
		return []FunctionVersion{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []FunctionVersion{}
	for _, e := range entries {
		if !e.IsDir() || !versionID.MatchString(e.Name()) {
			continue // a version being written, or a stray file
		}
		v, err := readVersion(stackDir, name, e.Name())
		if err != nil {
			continue
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out, nil
}

func readVersion(stackDir, name, id string) (FunctionVersion, error) {
	var v FunctionVersion
	b, err := os.ReadFile(filepath.Join(historyRoot(stackDir, name), id, "version.json"))
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(b, &v)
	return v, err
}

// ErrNoVersion is returned for a version that isn't kept.
var ErrNoVersion = errors.New("no such version")

// ReadFunctionVersion returns a kept version with its text files, and the
// paths of files that can't be shown as text.
func ReadFunctionVersion(stackDir, name, id string) (FunctionVersion, []FunctionFile, []string, error) {
	if ValidFunctionName(name) != nil || !versionID.MatchString(id) {
		return FunctionVersion{}, nil, nil, ErrNoVersion
	}
	v, err := readVersion(stackDir, name, id)
	if err != nil {
		return v, nil, nil, ErrNoVersion
	}
	dir := filepath.Join(historyRoot(stackDir, name), id, "files")
	files := []FunctionFile{}
	other := []string{}
	for _, f := range v.Files {
		if f.Link != "" || f.Unreadable || f.Size > MaxFunctionFileSize || ValidFunctionPath(f.Path) != nil {
			other = append(other, f.Path)
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(f.Path)))
		if err != nil {
			return v, nil, nil, err
		}
		if !utf8.Valid(b) || slices.Contains(b, 0) {
			other = append(other, f.Path)
			continue
		}
		files = append(files, FunctionFile{Path: f.Path, Content: string(b)})
	}
	return v, files, other, nil
}

// RecordFunctionVersion keeps the function's current files as a version,
// unless they're already its newest one; then it returns that one. Older
// versions beyond MaxFunctionVersions go.
func RecordFunctionVersion(stackDir, name, kind, by, restoredFrom string, now time.Time) (FunctionVersion, bool, error) {
	if err := ValidFunctionName(name); err != nil {
		return FunctionVersion{}, false, err
	}
	current := filepath.Join(functionsRoot(stackDir), name)
	files, sum, size, err := hashFunction(current)
	if err != nil {
		return FunctionVersion{}, false, err
	}
	existing, err := ListFunctionVersions(stackDir, name)
	if err != nil {
		return FunctionVersion{}, false, err
	}
	if len(existing) > 0 && existing[0].SHA256 == sum && kind == VersionFound {
		return existing[0], false, nil
	}
	suffix := make([]byte, 3)
	_, _ = rand.Read(suffix)
	// Ids sort by time, to the millisecond; each comes strictly after the
	// newest, so versions recorded in one request stay in order.
	t := now.UTC().Truncate(time.Millisecond)
	if len(existing) > 0 && !t.After(existing[0].CreatedAt) {
		t = existing[0].CreatedAt.Add(time.Millisecond)
	}
	id := t.Format("20060102T150405") + fmt.Sprintf("%03dZ-", t.Nanosecond()/1e6) + hex.EncodeToString(suffix)
	v := FunctionVersion{ID: id, Kind: kind, CreatedAt: t, CreatedBy: by, RestoredFrom: restoredFrom,
		SHA256: sum, Files: files, Size: size}
	if v.Files == nil {
		v.Files = []FileHash{}
	}
	root := historyRoot(stackDir, name)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return v, false, err
	}
	tmp := filepath.Join(root, ".tmp-"+id)
	if err := copyTree(current, filepath.Join(tmp, "files")); err != nil {
		_ = os.RemoveAll(tmp)
		return v, false, err
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	if err := os.WriteFile(filepath.Join(tmp, "version.json"), b, 0o600); err != nil {
		_ = os.RemoveAll(tmp)
		return v, false, err
	}
	if err := os.Rename(tmp, filepath.Join(root, id)); err != nil {
		_ = os.RemoveAll(tmp)
		return v, false, err
	}
	all := append([]FunctionVersion{v}, existing...)
	for _, old := range all[min(len(all), MaxFunctionVersions):] {
		_ = os.RemoveAll(filepath.Join(root, old.ID))
	}
	return v, true, nil
}

// RecordFoundVersion keeps the function as it is now, if it exists and
// isn't its newest kept version (see VersionFound), before it's changed.
func RecordFoundVersion(stackDir, name string, now time.Time) error {
	if ValidFunctionName(name) != nil {
		return nil // not a function (the change itself says so)
	}
	if fi, err := os.Stat(filepath.Join(functionsRoot(stackDir), name)); err != nil || !fi.IsDir() {
		return nil
	}
	_, _, err := RecordFunctionVersion(stackDir, name, VersionFound, "", "", now)
	return err
}

// RestoreFunctionVersion makes a kept version the function's files again
// (the function is recreated if it was deleted).
func RestoreFunctionVersion(stackDir, name, id string) error {
	if ValidFunctionName(name) != nil || !versionID.MatchString(id) {
		return ErrNoVersion
	}
	src := filepath.Join(historyRoot(stackDir, name), id, "files")
	if fi, err := os.Stat(src); err != nil || !fi.IsDir() {
		return ErrNoVersion
	}
	root := functionsRoot(stackDir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(root, ".restore-"+name+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp) // gone after the swap; cleans up after a failure
	if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	if err := copyTree(src, tmp); err != nil {
		return err
	}
	return swapIn(root, name, tmp)
}

// copyTree copies a folder's files, directories and symbolic links (as
// links, not followed) to dst.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrPermission) && p != src {
				if d != nil && d.IsDir() {
					return filepath.SkipDir // listed as unreadable in the version
				}
				return nil
			}
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case d.Type().IsRegular():
			fi, err := d.Info()
			if err != nil {
				return err
			}
			b, err := os.ReadFile(p)
			if errors.Is(err, fs.ErrPermission) {
				return nil // listed as unreadable in the version
			}
			if err != nil {
				return err
			}
			return os.WriteFile(target, b, fi.Mode().Perm())
		}
		return nil
	})
}
