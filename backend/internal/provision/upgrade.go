package provision

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// Upgrading a stack moves it to the template this Supermixer bundles: its
// files are rendered again (the stack's .env and Edge Functions kept), new
// .env keys added, the new images pulled, and the stack restarted on them.
// The previous files are kept in .pre-upgrade/ until the upgrade succeeds,
// so a failed one can go back.

// ImageChange is a service whose image an upgrade changes. From is empty
// for a new service, To for a removed one.
type ImageChange struct {
	Service, From, To string
}

// UpgradePlan is what upgrading a stack to the bundled template changes.
type UpgradePlan struct {
	To      string        // the bundled template
	Images  []ImageChange // by service
	NewKeys []string      // .env keys the new template adds
	// Blocked says why the upgrade can't run, if it can't.
	Blocked string
}

// snapshotDir holds a stack's files from before an upgrade.
const snapshotDir = ".pre-upgrade"

// userPath is a file an upgrade leaves alone: the user's Edge Functions
// (the main router is Supermixer's, so it's updated).
func userPath(rel string) bool {
	return strings.HasPrefix(rel, "volumes/functions/") && !strings.HasPrefix(rel, "volumes/functions/main/")
}

// PlanUpgrade compares a stack's files with the bundled template.
func PlanUpgrade(l Layout) (UpgradePlan, error) {
	plan := UpgradePlan{To: TemplateVersion()}
	files, err := templateFiles(l.Project)
	if err != nil {
		return plan, err
	}
	current := map[string]string{}
	for _, f := range []string{"docker-compose.yml", "docker-compose.logs.yml"} {
		b, err := os.ReadFile(filepath.Join(l.Dir, f))
		if err != nil {
			return plan, err
		}
		maps.Copy(current, composeImages(b))
	}
	next := map[string]string{}
	for _, f := range []string{"docker-compose.yml", "docker-compose.logs.yml"} {
		maps.Copy(next, composeImages(files[f].data))
	}
	for _, svc := range slices.Sorted(maps.Keys(mergeKeys(current, next))) {
		if current[svc] != next[svc] {
			plan.Images = append(plan.Images, ImageChange{Service: svc, From: current[svc], To: next[svc]})
		}
	}
	env, err := ReadEnv(l.Dir)
	if err != nil {
		return plan, err
	}
	for k := range parseEnvText(files[".env.example"].data) {
		if _, ok := env[k]; !ok {
			plan.NewKeys = append(plan.NewKeys, k)
		}
	}
	slices.Sort(plan.NewKeys)
	if from, to := postgresMajor(current["db"]), postgresMajor(next["db"]); from != to {
		plan.Blocked = fmt.Sprintf("the new version moves Postgres from %s to %s; Supermixer can't upgrade a database across major versions yet. Create a new project and move the data with a backup instead.",
			current["db"], next["db"])
	}
	return plan, nil
}

func mergeKeys(a, b map[string]string) map[string]string {
	out := maps.Clone(a)
	maps.Copy(out, b)
	return out
}

// postgresMajor is the major version in a supabase/postgres image tag
// ("supabase/postgres:17.6.1.136" is 17).
func postgresMajor(image string) string {
	_, tag, ok := strings.Cut(image, ":")
	if !ok {
		return image
	}
	return strings.SplitN(tag, ".", 2)[0]
}

var (
	serviceLine = regexp.MustCompile(`^  ([A-Za-z0-9_.-]+):\s*$`)
	imageLine   = regexp.MustCompile(`^    image:\s*(\S+)`)
)

// composeImages is each service's image in a compose file.
func composeImages(b []byte) map[string]string {
	out := map[string]string{}
	inServices, service := false, ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := sc.Text()
		if line != "" && line[0] != ' ' && line[0] != '#' {
			inServices, service = strings.HasPrefix(line, "services:"), ""
			continue
		}
		if !inServices {
			continue
		}
		if m := serviceLine.FindStringSubmatch(line); m != nil {
			service = m[1]
		} else if m := imageLine.FindStringSubmatch(line); m != nil && service != "" {
			out[service] = strings.Trim(m[1], `"'`)
		}
	}
	return out
}

// ApplyUpgrade writes the bundled template into a stack, after copying its
// current files to .pre-upgrade/. generated has values for .env keys the new
// template adds that Supermixer can make (secrets); other new keys get the
// template's defaults. It returns the keys added.
func ApplyUpgrade(l Layout, generated map[string]string) ([]string, error) {
	files, err := templateFiles(l.Project)
	if err != nil {
		return nil, err
	}
	if err := snapshot(l.Dir, files); err != nil {
		return nil, fmt.Errorf("keeping the current files: %w", err)
	}
	env, err := ReadEnv(l.Dir)
	if err != nil {
		return nil, err
	}
	add := map[string]string{}
	for k, v := range parseEnvText(files[".env.example"].data) {
		if _, ok := env[k]; ok {
			continue
		}
		if g, ok := generated[k]; ok {
			v = g
		}
		add[k] = v
	}
	if err := writeFiles(l.Dir, files, userPath); err != nil {
		return nil, err
	}
	// Only new keys: the .env's own lines (some quoted by Supermixer) stay.
	if len(add) > 0 {
		if err := UpdateEnv(l.Dir, add); err != nil {
			return nil, err
		}
	}
	if err := RefreshOverlay(l.Dir); err != nil {
		return nil, err
	}
	return slices.Sorted(maps.Keys(add)), nil
}

// snapshot copies the stack's .env and the files the template would write
// into .pre-upgrade/, replacing an earlier one.
func snapshot(dir string, files map[string]templateFile) error {
	snap := filepath.Join(dir, snapshotDir)
	tmp := snap + ".tmp"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	paths := []string{".env", "supermixer.yml"}
	for rel := range files {
		if !userPath(rel) {
			paths = append(paths, rel)
		}
	}
	for _, rel := range paths {
		src := filepath.Join(dir, filepath.FromSlash(rel))
		fi, err := os.Stat(src)
		if errors.Is(err, fs.ErrNotExist) {
			continue // new in this template
		}
		if err != nil {
			return err
		}
		dst := filepath.Join(tmp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		if err := copyFile(src, dst, fi.Mode().Perm()); err != nil {
			return err
		}
	}
	if err := os.RemoveAll(snap); err != nil {
		return err
	}
	return os.Rename(tmp, snap)
}

// RollBackUpgrade puts back the files from before an upgrade.
func RollBackUpgrade(dir string) error {
	snap := filepath.Join(dir, snapshotDir)
	return filepath.WalkDir(snap, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(snap, p)
		if err != nil {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		return copyFile(p, filepath.Join(dir, rel), fi.Mode().Perm())
	})
}

// FinishUpgrade removes the files kept for going back.
func FinishUpgrade(dir string) error { return os.RemoveAll(filepath.Join(dir, snapshotDir)) }

// copyFile writes src over dst atomically, with mode.
func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// Pull downloads the stack's images.
func (c Compose) Pull(ctx context.Context, log io.Writer) error {
	return c.Run(ctx, log, "pull", "--quiet")
}

// UpgradeInterrupted says an upgrade started on the stack and didn't finish
// or go back: its files are the new version's.
func UpgradeInterrupted(dir string) bool {
	fi, err := os.Stat(filepath.Join(dir, snapshotDir))
	return err == nil && fi.IsDir()
}

// StackVersion is the template the stack's files come from (its VERSION).
func StackVersion(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "VERSION"))
	return strings.TrimSpace(string(b)), err
}
