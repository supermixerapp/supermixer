package provision

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Edge Functions live in a stack's volumes/functions folder, one folder per
// function. The edge runtime's main service (volumes/functions/main) routes
// /functions/v1/<name> to the folder of that name.

const functionsDir = "volumes/functions"

// Limits for a function deployed from Supermixer.
const (
	MaxFunctionFiles    = 200
	MaxFunctionFileSize = 1 << 20  // 1 MiB
	MaxFunctionSize     = 10 << 20 // 10 MiB in all
)

// FunctionName is a function's name (its URL path), as Supabase allows.
var FunctionName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)

// Entrypoints the edge runtime starts a function from, in its root folder.
var Entrypoints = []string{"index.ts", "index.js", "index.tsx", "index.jsx", "index.mts", "index.mjs"}

// ErrNoFunction means the stack has no function of that name.
var ErrNoFunction = errors.New("no such function")

// ValidFunctionName reports why name can't be a function's name, or nil.
func ValidFunctionName(name string) error {
	if !FunctionName.MatchString(name) {
		return fmt.Errorf("a function name starts with a letter and has up to 64 letters, digits, - and _")
	}
	if name == "main" {
		return fmt.Errorf("main is the edge runtime's router; choose another name")
	}
	if name == "secrets" {
		return fmt.Errorf("secrets is taken by Supermixer's Secrets page; choose another name")
	}
	return nil
}

var pathSegment = regexp.MustCompile(`^[A-Za-z0-9_@+=,-][A-Za-z0-9_.@+=, -]*$`)

// ValidFunctionPath reports why p can't be a file's path in a function, or nil.
// Paths are relative, use /, and stay inside the function's folder.
func ValidFunctionPath(p string) error {
	if p == "" || len(p) > 255 {
		return fmt.Errorf("a file path has 1 to 255 characters")
	}
	parts := strings.Split(p, "/")
	if len(parts) > 10 {
		return fmt.Errorf("%s: folders nest at most 10 deep", p)
	}
	for _, s := range parts {
		if s == "" || s == "." || s == ".." || !pathSegment.MatchString(s) || strings.HasSuffix(s, " ") {
			return fmt.Errorf("%s: use relative paths of letters, digits, spaces and . _ - @ + = , (no leading dot)", p)
		}
	}
	return nil
}

// FunctionFile is one file of a function.
type FunctionFile struct {
	Path    string
	Content string
}

// FunctionInfo describes a function's folder.
type FunctionInfo struct {
	Name       string
	Updated    time.Time
	Files      int
	Size       int64
	Entrypoint string // "" when there's none
}

func functionsRoot(stackDir string) string {
	return filepath.Join(stackDir, filepath.FromSlash(functionsDir))
}

// ListFunctions lists a stack's functions, by name.
func ListFunctions(stackDir string) ([]FunctionInfo, error) {
	entries, err := os.ReadDir(functionsRoot(stackDir))
	if errors.Is(err, fs.ErrNotExist) {
		return []FunctionInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []FunctionInfo{}
	for _, e := range entries {
		if !e.IsDir() || ValidFunctionName(e.Name()) != nil {
			continue // main, deploy leftovers, files
		}
		info, err := functionInfo(stackDir, e.Name())
		if err != nil {
			return nil, err
		}
		out = append(out, info)
	}
	return out, nil
}

func functionInfo(stackDir, name string) (FunctionInfo, error) {
	root := filepath.Join(functionsRoot(stackDir), name)
	info := FunctionInfo{Name: name}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		if fi.ModTime().After(info.Updated) {
			info.Updated = fi.ModTime()
		}
		if d.Type().IsRegular() {
			info.Files++
			info.Size += fi.Size()
		}
		return nil
	})
	if err != nil {
		return FunctionInfo{}, err
	}
	for _, e := range Entrypoints {
		if fi, err := os.Stat(filepath.Join(root, e)); err == nil && fi.Mode().IsRegular() {
			info.Entrypoint = e
			break
		}
	}
	return info, nil
}

// ReadFunction returns a function's text files, and the paths of files that
// can't be edited as text (binary, too large, links), sorted by path.
func ReadFunction(stackDir, name string) (FunctionInfo, []FunctionFile, []string, error) {
	if ValidFunctionName(name) != nil {
		return FunctionInfo{}, nil, nil, ErrNoFunction
	}
	root := filepath.Join(functionsRoot(stackDir), name)
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		return FunctionInfo{}, nil, nil, ErrNoFunction
	}
	info, err := functionInfo(stackDir, name)
	if err != nil {
		return FunctionInfo{}, nil, nil, err
	}
	files := []FunctionFile{}
	other := []string{}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		fi, err := d.Info()
		if err != nil {
			return err
		}
		if !d.Type().IsRegular() || fi.Size() > MaxFunctionFileSize || ValidFunctionPath(rel) != nil {
			other = append(other, rel)
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if !utf8.Valid(b) || slices.Contains(b, 0) {
			other = append(other, rel)
			return nil
		}
		files = append(files, FunctionFile{Path: rel, Content: string(b)})
		return nil
	})
	if err != nil {
		return FunctionInfo{}, nil, nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	sort.Strings(other)
	return info, files, other, nil
}

// validKeepPath: files that can't be edited (dot files, unusual names, deep
// folders) are kept by path, so the rule is only "relative and inside".
func validKeepPath(p string) bool {
	if p == "" || len(p) > 1024 || strings.Contains(p, "\x00") || strings.HasPrefix(p, "/") {
		return false
	}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." {
			return false
		}
	}
	return filepath.IsLocal(filepath.FromSlash(p))
}

// WriteFunction replaces (or creates) a function with files, carrying over
// the existing files listed in keep unchanged. The new folder is written
// beside the old one and swapped in, so a failed write changes nothing.
func WriteFunction(stackDir, name string, files []FunctionFile, keep []string) error {
	if err := ValidFunctionName(name); err != nil {
		return err
	}
	if len(files)+len(keep) > MaxFunctionFiles {
		return fmt.Errorf("a function has at most %d files", MaxFunctionFiles)
	}
	seen := map[string]bool{}
	total := 0
	entry := false
	for _, f := range files {
		if err := ValidFunctionPath(f.Path); err != nil {
			return err
		}
		if seen[f.Path] {
			return fmt.Errorf("%s is listed twice", f.Path)
		}
		seen[f.Path] = true
		if len(f.Content) > MaxFunctionFileSize {
			return fmt.Errorf("%s is over %d MiB", f.Path, MaxFunctionFileSize>>20)
		}
		total += len(f.Content)
		entry = entry || slices.Contains(Entrypoints, f.Path)
	}
	root := functionsRoot(stackDir)
	current := filepath.Join(root, name)
	// Kept files are read through an os.Root of the function's folder, so a
	// symlink in the path can't reach a file outside it.
	var cur *os.Root
	if len(keep) > 0 {
		var err error
		if cur, err = os.OpenRoot(current); err != nil {
			return fmt.Errorf("%s has no files to keep", name)
		}
		defer cur.Close()
	}
	for _, k := range keep {
		if !validKeepPath(k) {
			return fmt.Errorf("%s: a kept file's path must be relative and inside the function", k)
		}
		if seen[k] {
			return fmt.Errorf("%s is both kept and replaced", k)
		}
		seen[k] = true
		fi, err := cur.Lstat(filepath.FromSlash(k))
		if err != nil || !(fi.Mode().IsRegular() || fi.Mode()&fs.ModeSymlink != 0) {
			return fmt.Errorf("%s isn't a file of %s to keep", k, name)
		}
		if fi.Mode().IsRegular() {
			total += int(fi.Size())
		}
		entry = entry || slices.Contains(Entrypoints, k)
	}
	if total > MaxFunctionSize {
		return fmt.Errorf("a function is at most %d MiB in all", MaxFunctionSize>>20)
	}
	if !entry {
		return fmt.Errorf("a function needs an entrypoint at its top level: %s", strings.Join(Entrypoints, ", "))
	}

	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(root, ".deploy-"+name+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp) // gone after the swap; cleans up after a failure
	if err := os.Chmod(tmp, 0o755); err != nil {
		return err
	}
	write := func(rel string, b []byte, mode fs.FileMode) error {
		dst := filepath.Join(tmp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, b, mode)
	}
	for _, f := range files {
		if err := write(f.Path, []byte(f.Content), 0o644); err != nil {
			return err
		}
	}
	for _, k := range keep {
		src := filepath.FromSlash(k)
		fi, err := cur.Lstat(src)
		if err != nil {
			return err
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			target, err := cur.Readlink(src) // copied as a link, not followed
			if err != nil {
				return err
			}
			dst := filepath.Join(tmp, filepath.FromSlash(k))
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(target, dst); err != nil {
				return err
			}
			continue
		}
		b, err := cur.ReadFile(src)
		if err != nil {
			return err
		}
		if err := write(k, b, fi.Mode().Perm()); err != nil {
			return err
		}
	}

	old := ""
	if _, err := os.Lstat(current); err == nil {
		old = filepath.Join(root, fmt.Sprintf(".old-%s-%d", name, time.Now().UnixNano()))
		if err := os.Rename(current, old); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, current); err != nil {
		if old != "" {
			_ = os.Rename(old, current)
		}
		return err
	}
	if old != "" {
		_ = os.RemoveAll(old)
	}
	return nil
}

// DeleteFunction removes a function's folder.
func DeleteFunction(stackDir, name string) error {
	if ValidFunctionName(name) != nil {
		return ErrNoFunction
	}
	dir := filepath.Join(functionsRoot(stackDir), name)
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return ErrNoFunction
	}
	// Renamed first, so the runtime never sees a half-deleted function.
	gone := filepath.Join(functionsRoot(stackDir), fmt.Sprintf(".old-%s-%d", name, time.Now().UnixNano()))
	if err := os.Rename(dir, gone); err != nil {
		return err
	}
	// The function is gone once renamed; files a container's user owns
	// (Linux bind mounts) may stay behind in the hidden folder, which the
	// runtime can't route to and the stack's deletion removes.
	_ = os.RemoveAll(gone)
	return nil
}

// ---------------------------------------------------------------- secrets

// Function secrets are environment variables of the functions container
// (the runtime hands its environment to every function), kept in the
// stack's functions.env, which the overlay gives the service as an env_file.

const functionSecretsFile = "functions.env"

// SecretName is a secret's name: an environment variable name.
var SecretName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,255}$`)

// Limits for function secrets.
const (
	MaxSecrets     = 200
	MaxSecretValue = 64 << 10
)

// ValidSecretName reports why name can't name a function secret, or nil.
// The stack sets some variables itself; they'd win over a secret, so a
// secret of that name would silently do nothing.
func ValidSecretName(name string) error {
	if !SecretName.MatchString(name) {
		return fmt.Errorf("%q: a secret's name has letters, digits and _, and doesn't start with a digit", name)
	}
	upper := strings.ToUpper(name)
	if strings.HasPrefix(upper, "SUPABASE_") || strings.HasPrefix(upper, "SB_") {
		return fmt.Errorf("%s: names starting with SUPABASE_ or SB_ are reserved; the stack sets them", name)
	}
	if upper == "JWT_SECRET" || upper == "VERIFY_JWT" {
		return fmt.Errorf("%s is set by the stack", name)
	}
	return nil
}

// ValidSecretValue reports why v can't be a secret's value, or nil:
// environment variables can't hold NUL, and other control characters
// (besides tab and line breaks) are almost certainly a paste mistake.
func ValidSecretValue(name, v string) error {
	if len(v) > MaxSecretValue {
		return fmt.Errorf("%s: a value is at most %d KiB", name, MaxSecretValue>>10)
	}
	if !utf8.ValidString(v) {
		return fmt.Errorf("%s: the value isn't valid UTF-8 text", name)
	}
	for _, r := range v {
		if (r < 0x20 && r != '\t' && r != '\n' && r != '\r') || r == 0x7f {
			return fmt.Errorf("%s: the value has a control character (U+%04X)", name, r)
		}
	}
	return nil
}

// ReadFunctionSecrets reads a stack's function secrets (none if the file is missing).
func ReadFunctionSecrets(stackDir string) (map[string]string, error) {
	return readEnvFile(filepath.Join(stackDir, functionSecretsFile))
}

// parseQuotedEnv reads KEY="escaped" lines as Supermixer writes them. People
// edit these files by hand too: unquoted and single-quoted values, export,
// CRLF and lines without = are read as Compose would (roughly), not refused.
func parseQuotedEnv(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		k, v, ok := strings.Cut(line, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			continue
		}
		out[k] = unquoteEnv(strings.TrimSpace(v))
	}
	return out
}

// WriteFunctionSecrets replaces a stack's function secrets.
func WriteFunctionSecrets(stackDir string, secrets map[string]string) error {
	return writeEnvFile(filepath.Join(stackDir, functionSecretsFile), secrets,
		"# Edge Function secrets, written by Supermixer. Edit them in Supermixer.")
}

// quoteEnv writes v as a double-quoted env_file value, which Compose reads
// back exactly: backslash escapes for \ " and control characters, and $$
// for $ (Compose interpolates ${…} in double-quoted values).
func quoteEnv(v string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range v {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '$':
			b.WriteString("$$")
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func unquoteEnv(s string) string {
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return s[1 : len(s)-1] // literal
	}
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		if i := strings.Index(s, " #"); i >= 0 {
			s = strings.TrimSpace(s[:i]) // an inline comment
		}
		return strings.ReplaceAll(s, "$$", "$")
	}
	s = s[1 : len(s)-1]
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s):
			i++
			switch s[i] {
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			default:
				b.WriteByte(s[i])
			}
		case c == '$' && i+1 < len(s) && s[i+1] == '$':
			i++
			b.WriteByte('$')
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// RefreshOverlay rewrites a stack's supermixer.yml with this version's
// overlay (stacks created before a change to it pick the change up), and
// makes sure the files it names exist.
func RefreshOverlay(stackDir string) error {
	if err := ensureSecretsFile(stackDir); err != nil {
		return err
	}
	if err := ensureDrainsConfig(stackDir); err != nil {
		return err
	}
	o, err := renderOverlay(stackDir)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(stackDir, overlayName), []byte(o), 0o644)
}

// ensureSecretsFile creates empty functions.env and auth.env files if
// they're missing: the overlay names them, and Compose before 2.24 can't
// mark an env_file optional.
func ensureSecretsFile(stackDir string) error {
	if _, err := os.Stat(filepath.Join(stackDir, functionSecretsFile)); err != nil {
		if err := WriteFunctionSecrets(stackDir, map[string]string{}); err != nil {
			return err
		}
	}
	if _, err := os.Stat(filepath.Join(stackDir, authEnvFile)); err != nil {
		if err := writeEnvFile(filepath.Join(stackDir, authEnvFile), map[string]string{},
			"# Auth settings, written by Supermixer. Change them in Supermixer: Authentication."); err != nil {
			return err
		}
	}
	return os.MkdirAll(filepath.Join(stackDir, filepath.FromSlash(authTemplatesDir)), 0o755)
}

// SecretDigest is how a secret is shown without its value, as the Supabase
// CLI does: the hex SHA-256 of the value.
func SecretDigest(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}
