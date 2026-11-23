// Package provision creates and runs self-hosted Supabase stacks with Docker
// Compose, from a copy of supabase/docker bundled at a pinned commit
// (template/, see sync-template.sh; Apache-2.0, see NOTICE).
package provision

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

//go:embed all:template
var templateFS embed.FS

// TemplateVersion is the supabase/supabase commit the template comes from.
func TemplateVersion() string {
	b, err := templateFS.ReadFile("template/VERSION")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(b))
}

// Compose files a stack runs with, in order. supermixer.yml is Supermixer's
// own overrides.
var composeFiles = []string{"docker-compose.yml", "docker-compose.logs.yml", overlayName}

const overlayName = "supermixer.yml"

// The overlay keeps data the containers write on named Docker volumes instead
// of folders in the stack's directory:
//   - Postgres's data and Studio's snippets are owned by the containers' users,
//     so Supermixer couldn't delete the folder afterwards on Linux; `docker
//     compose down --volumes` removes named volumes cleanly.
//   - Storage's file backend needs extended attributes, which some bind mounts
//     (Docker Desktop's) don't support.
//
// It also gives the functions service the stack's Edge Function secrets.
//
// Compose merges a service's volumes by their path in the container, so these
// replace the bind mounts of the same paths.
const overlay = `# Written by Supermixer: data the containers write lives on named volumes.
services:
  db:
    volumes:
      - db-data:/var/lib/postgresql/data
  studio:
    volumes:
      - studio-snippets:/app/snippets
  functions:
    env_file:
      - ./functions.env
  storage:
    volumes:
      - storage-files:/var/lib/storage
  imgproxy:
    volumes:
      - storage-files:/var/lib/storage

volumes:
  db-data:
  studio-snippets:
  storage-files:
`

// Layout is where a stack's files go and what it's called.
type Layout struct {
	Dir     string // the stack's folder
	Project string // the Docker Compose project name
}

// WriteStack writes the template into l.Dir with env as its .env, scoped so
// it can run next to other stacks. l.Dir must not exist yet.
func WriteStack(l Layout, env map[string]string) error {
	if _, err := os.Stat(l.Dir); err == nil {
		return fmt.Errorf("%s already exists", l.Dir)
	}
	if err := os.MkdirAll(l.Dir, 0o700); err != nil {
		return err
	}
	compose, err := fs.ReadFile(templateFS, "template/docker-compose.yml")
	if err != nil {
		return err
	}
	logs, err := fs.ReadFile(templateFS, "template/docker-compose.logs.yml")
	if err != nil {
		return err
	}
	scopedCompose, err := scopeContainers(string(compose))
	if err != nil {
		return fmt.Errorf("docker-compose.yml: %w", err)
	}
	if scopedCompose, err = enableJWKS(scopedCompose); err != nil {
		return err
	}
	scopedLogs, err := scopeContainers(string(logs))
	if err != nil {
		return fmt.Errorf("docker-compose.logs.yml: %w", err)
	}
	names := serviceAliases(scopedCompose, scopedLogs)

	err = fs.WalkDir(templateFS, "template", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(p, "template"), "/")
		dst := filepath.Join(l.Dir, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, err := fs.ReadFile(templateFS, p)
		if err != nil {
			return err
		}
		switch rel {
		case "docker-compose.yml":
			b = []byte(scopedCompose)
		case "docker-compose.logs.yml":
			b = []byte(scopedLogs)
		case "volumes/functions/main/index.ts":
			m, err := hideJWTSecret(string(b))
			if err != nil {
				return err
			}
			b = []byte(m)
		case "volumes/logs/vector.yml":
			v, err := scopeVector(string(b), l.Project, names)
			if err != nil {
				return err
			}
			b = []byte(v)
		case ".env.example":
			// .env is written below; keep the original for reference.
		}
		// Embedding drops file modes; entrypoint scripts must stay runnable.
		mode := os.FileMode(0o644)
		if path.Ext(rel) == ".sh" {
			mode = 0o755
		}
		return os.WriteFile(dst, b, mode)
	})
	if err != nil {
		return err
	}
	if err := RefreshOverlay(l.Dir); err != nil {
		return err
	}
	example, err := fs.ReadFile(templateFS, "template/.env.example")
	if err != nil {
		return err
	}
	// So docker compose run by hand in the folder means the same stack.
	all := map[string]string{"COMPOSE_PROJECT_NAME": l.Project, "COMPOSE_FILE": strings.Join(composeFiles, ":")}
	for k, v := range env {
		all[k] = v
	}
	return os.WriteFile(filepath.Join(l.Dir, ".env"), []byte(renderEnv(string(example), all)), 0o600)
}

var envKey = regexp.MustCompile(`^([A-Z][A-Z0-9_]*)=`)

// renderEnv sets each key in example: replacing its first line, or appending
// it. Values are written as they are, as Supabase's scripts do; generated
// values never contain newlines or quotes.
func renderEnv(example string, values map[string]string) string {
	lines := splitLines(example)
	done := map[string]bool{}
	for i, line := range lines {
		m := envKey.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		v, ok := values[m[1]]
		if !ok || done[m[1]] {
			continue
		}
		lines[i] = m[1] + "=" + v + "\n"
		done[m[1]] = true
	}
	var extra []string
	for k := range values {
		if !done[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	out := strings.Join(lines, "")
	if len(extra) > 0 {
		if !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		out += "\n# Set by Supermixer\n"
		for _, k := range extra {
			out += k + "=" + values[k] + "\n"
		}
	}
	return out
}

// ReadEnv reads KEY=value lines from a stack's .env.
func ReadEnv(dir string) (map[string]string, error) {
	b, err := os.ReadFile(filepath.Join(dir, ".env"))
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, line := range splitLines(string(b)) {
		line = strings.TrimRight(line, "\r\n")
		if m := envKey.FindStringSubmatch(line); m != nil {
			if _, seen := out[m[1]]; !seen {
				out[m[1]] = line[len(m[0]):]
			}
		}
	}
	return out, nil
}

var dbImage = regexp.MustCompile(`(?m)^  db:\s*\n(?:    .*\n|\s*\n)*?    image:\s*(\S+)`)

// StackImage is the image of a stack's Postgres service, from its compose file.
func StackImage(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, "docker-compose.yml"))
	if err != nil {
		return "", err
	}
	m := dbImage.FindSubmatch(b)
	if m == nil {
		return "", fmt.Errorf("no db image in %s", filepath.Join(dir, "docker-compose.yml"))
	}
	return string(m[1]), nil
}

// The edge runtime's router hands every function its own environment. Only
// the router needs JWT_SECRET (to check tokens); a function with it could
// sign a token for anyone, so it's left out.
const (
	workerEnvLine   = "const envVarsObj = { ...Deno.env.toObject(), SUPABASE_FUNCTION_SLUG: service_name }"
	workerEnvHidden = "// Supermixer: functions don't get JWT_SECRET; only this router uses it.\n" +
		"  const { JWT_SECRET: _routerOnly, ...workerEnv } = Deno.env.toObject()\n" +
		"  const envVarsObj = { ...workerEnv, SUPABASE_FUNCTION_SLUG: service_name }"
)

func hideJWTSecret(router string) (string, error) {
	if strings.Count(router, workerEnvLine) != 1 {
		return "", fmt.Errorf("volumes/functions/main/index.ts: can't find where functions get their environment; update hideJWTSecret for this template")
	}
	return strings.Replace(router, workerEnvLine, workerEnvHidden, 1), nil
}
