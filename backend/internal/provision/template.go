// Package provision creates and runs self-hosted Supabase stacks with Docker
// Compose, from a copy of supabase/docker bundled at a pinned commit
// (template/, see sync-template.sh; Apache-2.0, see NOTICE).
package provision

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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
// It also gives the functions service the stack's Edge Function secrets, the
// auth service its settings (auth.env), Storage its upload limit and image
// transformations (from .env), Vector the log drains' config, and
// adds auth-templates: a tiny file
// server for custom email templates, since Auth only fetches them over HTTP.
// It runs on the stack's own Studio image (already pulled; it has Node).
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
{{STUDIO_OFF}}  functions:
    env_file:
      - ./functions.env
    environment:
      # Not the postgres login: functions_user, which acts as service_role
      # (see functions_db.go), unless the project chose otherwise.
      SUPABASE_DB_URL: postgresql://${FUNCTIONS_DB_LOGIN}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}
      # Read by the router (hideJWTSecret): false withholds the admin keys and the database URL.
      SUPERMIXER_FUNCTIONS_ADMIN_ACCESS: ${FUNCTIONS_ADMIN_ACCESS:-true}
  auth:
    env_file:
      - ./auth.env
    environment:
{{AUTH_ENVIRONMENT}}
  auth-templates:
    image: {{STUDIO_IMAGE}}
    restart: unless-stopped
    user: "1000:1000"
    entrypoint: ["node", "-e", {{TEMPLATE_SERVER}}]
    # Its own check: the Studio image's would probe Studio's port.
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:8080/',r=>process.exit(r.statusCode===404?0:1)).on('error',()=>process.exit(1))"]
      interval: 5s
      timeout: 5s
      retries: 3
    volumes:
      - ./volumes/auth-templates:/templates:ro,z
  storage:
    volumes:
      - storage-files:/var/lib/storage
    environment:
      # Storage › Settings (storageconfig.go); the template's values otherwise.
      FILE_SIZE_LIMIT: ${STORAGE_FILE_SIZE_LIMIT:-52428800}
      ENABLE_IMAGE_TRANSFORMATION: ${STORAGE_IMAGE_TRANSFORMATION:-true}
  imgproxy:
    volumes:
      - storage-files:/var/lib/storage
{{VECTOR}}
volumes:
  db-data:
    # Restores start a new database in a fresh volume (DB_DATA_VOLUME), so a
    # failed one can go back to the old; the default is Compose's usual name.
    name: ${COMPOSE_PROJECT_NAME}_${DB_DATA_VOLUME:-db-data}
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
	files, err := templateFiles(l.Project)
	if err != nil {
		return err
	}
	if err := writeFiles(l.Dir, files, nil); err != nil {
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
	all := map[string]string{"COMPOSE_PROJECT_NAME": l.Project, "COMPOSE_FILE": strings.Join(filesFor(env), ":")}
	for k, v := range env {
		all[k] = v
	}
	return os.WriteFile(filepath.Join(l.Dir, ".env"), []byte(renderEnv(string(example), all)), 0o600)
}

// templateFile is one of the template's files, rendered for a stack.
type templateFile struct {
	data []byte
	mode os.FileMode
}

// templateFiles renders the bundled template for the Compose project: every
// file by its path in the stack's folder (slash-separated), .env aside.
func templateFiles(project string) (map[string]templateFile, error) {
	compose, err := fs.ReadFile(templateFS, "template/docker-compose.yml")
	if err != nil {
		return nil, err
	}
	logs, err := fs.ReadFile(templateFS, "template/docker-compose.logs.yml")
	if err != nil {
		return nil, err
	}
	scopedCompose, err := scopeContainers(string(compose))
	if err != nil {
		return nil, fmt.Errorf("docker-compose.yml: %w", err)
	}
	if scopedCompose, err = enableJWKS(scopedCompose); err != nil {
		return nil, err
	}
	scopedLogs, err := scopeContainers(string(logs))
	if err != nil {
		return nil, fmt.Errorf("docker-compose.logs.yml: %w", err)
	}
	names := serviceAliases(scopedCompose, scopedLogs)

	files := map[string]templateFile{}
	err = fs.WalkDir(templateFS, "template", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel := strings.TrimPrefix(p, "template/")
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
			v, err := scopeVector(string(b), project, names)
			if err != nil {
				return err
			}
			b = []byte(v)
		}
		// Embedding drops file modes; entrypoint scripts must stay runnable.
		mode := os.FileMode(0o644)
		if path.Ext(rel) == ".sh" {
			mode = 0o755
		}
		files[rel] = templateFile{b, mode}
		return nil
	})
	return files, err
}

// writeFiles writes files into dir, except those skip says to keep.
func writeFiles(dir string, files map[string]templateFile, skip func(rel string) bool) error {
	for rel, f := range files {
		if skip != nil && skip(rel) {
			continue
		}
		dst := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dst, f.data, f.mode); err != nil {
			return err
		}
		if err := os.Chmod(dst, f.mode); err != nil {
			return err
		}
	}
	return nil
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
	return parseEnvText(b), nil
}

// ExampleEnv is the template's .env.example, as ReadEnv reads it.
func ExampleEnv() map[string]string {
	b, _ := fs.ReadFile(templateFS, "template/.env.example")
	return parseEnvText(b)
}

func parseEnvText(b []byte) map[string]string {
	out := map[string]string{}
	for _, line := range splitLines(string(b)) {
		line = strings.TrimRight(line, "\r\n")
		if m := envKey.FindStringSubmatch(line); m != nil {
			if _, seen := out[m[1]]; !seen {
				// As Compose reads it: quotes, escapes, $$ and inline comments.
				out[m[1]] = unquoteEnv(line[len(m[0]):])
			}
		}
	}
	return out
}

// StackImage is the image of a stack's Postgres service, from its compose file.
func StackImage(dir string) (string, error) { return serviceImage(dir, "db") }

// The edge runtime's router hands every function its own environment. Only
// the router needs JWT_SECRET (to check tokens); a function with it could
// sign a token for anyone, so it's left out. Without
// admin access (FUNCTIONS_ADMIN_ACCESS=false, Edge Functions › Secrets),
// functions don't get the service-role key, the secret keys or the database
// URL either, so they act as whoever calls them.
const (
	workerEnvLine = "const envVarsObj = { ...Deno.env.toObject(), SUPABASE_FUNCTION_SLUG: service_name }"
	// workerEnvHiddenV1 is what stacks created before the admin access setting have.
	workerEnvHiddenV1 = "// Supermixer: functions don't get JWT_SECRET; only this router uses it.\n" +
		"  const { JWT_SECRET: _routerOnly, ...workerEnv } = Deno.env.toObject()\n" +
		"  const envVarsObj = { ...workerEnv, SUPABASE_FUNCTION_SLUG: service_name }"
	workerEnvHidden = "// Supermixer: functions don't get JWT_SECRET; only this router uses it. Without\n" +
		"  // admin access (Supermixer: Edge Functions › Secrets) they act as their caller.\n" +
		"  const { JWT_SECRET: _routerOnly, SUPERMIXER_FUNCTIONS_ADMIN_ACCESS: adminAccess, ...workerEnv } = Deno.env.toObject()\n" +
		"  if (adminAccess === 'false') {\n" +
		"    delete workerEnv.SUPABASE_SERVICE_ROLE_KEY\n" +
		"    delete workerEnv.SUPABASE_SECRET_KEYS\n" +
		"    delete workerEnv.SUPABASE_DB_URL\n" +
		"  }\n" +
		"  const envVarsObj = { ...workerEnv, SUPABASE_FUNCTION_SLUG: service_name }"
)

// hideJWTSecret patches the router (volumes/functions/main/index.ts): from
// the template's, or from the patch older stacks have.
func hideJWTSecret(router string) (string, error) {
	switch {
	case strings.Contains(router, workerEnvHidden):
		return router, nil
	case strings.Count(router, workerEnvHiddenV1) == 1:
		return strings.Replace(router, workerEnvHiddenV1, workerEnvHidden, 1), nil
	case strings.Count(router, workerEnvLine) == 1:
		return strings.Replace(router, workerEnvLine, workerEnvHidden, 1), nil
	}
	return "", fmt.Errorf("volumes/functions/main/index.ts: can't find where functions get their environment; update hideJWTSecret for this template")
}

// routerFile is the edge runtime's router, in a stack's folder.
const routerFile = "volumes/functions/main/index.ts"

// ensureRouterPatch brings a stack's router up to the current patch (stacks
// created before the admin access setting). A router changed by hand is
// left alone, unless admin access is off, which needs the patch.
func ensureRouterPatch(stackDir string, adminAccess bool) error {
	path := filepath.Join(stackDir, filepath.FromSlash(routerFile))
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) && adminAccess {
			return nil
		}
		return fmt.Errorf("reading the functions router: %w", err)
	}
	patched, err := hideJWTSecret(string(b))
	if err != nil {
		if adminAccess {
			return nil
		}
		return fmt.Errorf("can't turn off the functions' admin access: %w", err)
	}
	if patched == string(b) {
		return nil
	}
	return writeFileAtomic(path, []byte(patched), 0o644)
}

// FunctionsAdminAccessOf reports whether a stack's functions get the
// service-role key, the secret keys and the database URL (the default).
func FunctionsAdminAccessOf(env map[string]string) bool {
	return env["FUNCTIONS_ADMIN_ACCESS"] != "false"
}

const authTemplatesService = "auth-templates"

// templateServer serves /templates/<name>.html, and nothing else.
const templateServer = `const h=require('http'),f=require('fs'),p=require('path');` +
	`h.createServer((q,r)=>{const n=p.basename((q.url||'').split('?')[0]);` +
	`if(q.method!=='GET'||!/^[a-z_]+\.html$/.test(n)){r.writeHead(404);return r.end()}` +
	`f.readFile(p.join('/templates',n),(e,b)=>{if(e){r.writeHead(404);return r.end()}` +
	`r.writeHead(200,{'content-type':'text/html; charset=utf-8'});r.end(b)})}).listen(8080)`

// studioOff, in the overlay of a stack without Studio: Studio only starts if
// asked for by name (its profile), and the gateway, which waits for it in
// Supabase's compose file, doesn't (!reset needs Compose 2.24 or later).
// The gateway's routes to Studio then answer 503.
const studioOff = `    profiles: ["studio"]
  api-gw:
    depends_on: !reset []
`

// StudioEnv is the stack .env setting that says whether it runs Studio
// (provisioning.studio, applied by Supermixer); missing means it doesn't.
const StudioEnv = "SUPERMIXER_STUDIO"

// StudioOf reports whether a stack runs Studio, from its .env.
func StudioOf(env map[string]string) bool { return env[StudioEnv] == "true" }

// LogsEnv is the stack .env setting that says whether it collects logs:
// runs Logflare and Vector (docker-compose.logs.yml). Missing means it does,
// as stacks did before the setting.
const LogsEnv = "SUPERMIXER_LOGS"

const logsFile = "docker-compose.logs.yml"

// LogsOf reports whether a stack collects logs, from its .env.
func LogsOf(env map[string]string) bool { return env[LogsEnv] != "false" }

// filesFor are the compose files a stack runs with: without the logs file
// when it doesn't collect logs.
func filesFor(env map[string]string) []string {
	if LogsOf(env) {
		return composeFiles
	}
	var out []string
	for _, f := range composeFiles {
		if f != logsFile {
			out = append(out, f)
		}
	}
	return out
}

// vectorOverlay, in the overlay of a stack that collects logs: log drains
// are a second Vector config with their sinks (drains.go).
const vectorOverlay = `  vector:
    # Log drains: a second config with their sinks (drains.go).
    volumes:
      - ./volumes/logs/drains:/etc/vector/drains:ro,z
    command: ["--config", "/etc/vector/vector.yml", "--config", "/etc/vector/drains/drains.yml"]
`

// SetLogs records whether a stack collects logs in its .env (with
// COMPOSE_FILE, so compose run by hand in its folder agrees) and rewrites
// its overlay. Starting the stack then adds or removes Logflare and Vector.
func SetLogs(dir string, on bool) error {
	old, err := ReadEnv(dir)
	if err != nil {
		return err
	}
	env := map[string]string{LogsEnv: strconv.FormatBool(on)}
	env["COMPOSE_FILE"] = strings.Join(filesFor(env), ":")
	if err := UpdateEnv(dir, env); err != nil {
		return err
	}
	if err := RefreshOverlay(dir); err != nil {
		// Back to what it said, so the stack's files agree with each other.
		before := map[string]string{LogsEnv: strconv.FormatBool(LogsOf(old)), "COMPOSE_FILE": strings.Join(filesFor(old), ":")}
		if v, ok := old["COMPOSE_FILE"]; ok {
			before["COMPOSE_FILE"] = v
		}
		_ = UpdateEnv(dir, before)
		return err
	}
	return nil
}

// renderOverlay is the overlay for a stack, with its Studio image, Studio
// left out unless studio, and Vector's part only if it collects logs.
func renderOverlay(stackDir string, studio, logs bool) (string, error) {
	image, err := serviceImage(stackDir, "studio")
	if err != nil {
		// A hand-edited compose file: use the bundled template's Studio image.
		compose, _ := fs.ReadFile(templateFS, "template/docker-compose.yml")
		if image, err = imageIn(compose, "studio"); err != nil {
			return "", err
		}
	}
	server, _ := json.Marshal(templateServer)
	// Each OAuth provider's callback follows the stack's API URL.
	var env strings.Builder
	for _, p := range OAuthProviders {
		env.WriteString("      GOTRUE_EXTERNAL_" + strings.ToUpper(p) + "_REDIRECT_URI: ${API_EXTERNAL_URL}/callback\n")
	}
	off := studioOff
	if studio {
		off = ""
	}
	vector := ""
	if logs {
		vector = vectorOverlay
	}
	return strings.NewReplacer("{{STUDIO_IMAGE}}", image, "{{TEMPLATE_SERVER}}", string(server),
		"{{AUTH_ENVIRONMENT}}\n", env.String(), "{{STUDIO_OFF}}", off, "{{VECTOR}}", vector).Replace(overlay), nil
}

// serviceImage is a service's image, from the stack's compose file.
func serviceImage(stackDir, service string) (string, error) {
	b, err := os.ReadFile(filepath.Join(stackDir, "docker-compose.yml"))
	if err != nil {
		return "", err
	}
	image, err := imageIn(b, service)
	if err != nil {
		return "", fmt.Errorf("%w in %s", err, filepath.Join(stackDir, "docker-compose.yml"))
	}
	return image, nil
}

func imageIn(b []byte, service string) (string, error) {
	re := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(service) + `:\s*\n(?:    .*\n|\s*\n)*?    image:\s*(\S+)`)
	m := re.FindSubmatch(b)
	if m == nil {
		return "", fmt.Errorf("no %s image", service)
	}
	return string(m[1]), nil
}
