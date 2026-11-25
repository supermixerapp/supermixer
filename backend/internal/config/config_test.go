package config

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const validKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // 32 bytes

func write(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".env.toml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const minimal = `
[database]
url = "postgres://file@localhost/db"
[security]
encryption_key = "` + validKey + `"
`

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(write(t, minimal), true)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Appearance.BrandColor != "#0019A8" || cfg.Server.Listen != ":8080" || cfg.Appearance.DefaultTheme != "light" {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
	if cfg.Security.SignIn.MaxFailures != 10 || cfg.Projects.QueryTimeout != time.Minute {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadFileValues(t *testing.T) {
	cfg, err := Load(write(t, minimal+`
[security.sign_in]
max_failures = 3
lockout = "2m"
[appearance]
brand_color = "#123456"
[projects]
query_timeout = "15s"
`), true)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Security.SignIn.MaxFailures != 3 || cfg.Security.SignIn.Lockout != 2*time.Minute {
		t.Errorf("sign_in = %+v", cfg.Security.SignIn)
	}
	if cfg.Appearance.BrandColor != "#123456" || cfg.Projects.QueryTimeout != 15*time.Second {
		t.Errorf("cfg = %+v", cfg)
	}
}

func TestEnvOverridesFile(t *testing.T) {
	t.Setenv("SUPERMIXER_APPEARANCE_BRAND_COLOR", "#abcdef")
	t.Setenv("SUPERMIXER_SECURITY_SIGN_IN_MAX_FAILURES", "5")
	t.Setenv("SUPERMIXER_SERVER_TRUST_PROXY", "true")
	t.Setenv("SUPERMIXER_SECURITY_SESSION_TTL", "1h")
	cfg, err := Load(write(t, minimal), true)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Appearance.BrandColor != "#abcdef" || cfg.Security.SignIn.MaxFailures != 5 || !cfg.Server.TrustProxy || cfg.Security.SessionTTL != time.Hour {
		t.Errorf("cfg = %+v", cfg)
	}
	if cfg.Database.URL != "postgres://file@localhost/db" {
		t.Errorf("database.url = %q, want the file's value", cfg.Database.URL)
	}
}

func TestEnvOnlyWithoutFile(t *testing.T) {
	t.Setenv("SUPERMIXER_DATABASE_URL", "postgres://env@localhost/db")
	t.Setenv("SUPERMIXER_SECURITY_ENCRYPTION_KEY", validKey)
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.toml"), false)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Database.URL != "postgres://env@localhost/db" {
		t.Errorf("database.url = %q", cfg.Database.URL)
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.toml"), true); err == nil {
		t.Error("an explicitly named missing file should be an error")
	}
}

func TestUnknownKeysAreRejected(t *testing.T) {
	_, err := Load(write(t, minimal+"\n[appearance]\nbrand_colour = \"#000000\"\n"), true)
	if err == nil || !strings.Contains(err.Error(), "appearance.brand_colour") {
		t.Fatalf("err = %v", err)
	}
}

func TestValidationNamesKeys(t *testing.T) {
	t.Setenv("SUPERMIXER_SECURITY_SIGN_IN_MAX_FAILURES", "lots")
	_, err := Load(write(t, minimal), true)
	if err == nil || !strings.Contains(err.Error(), "SUPERMIXER_SECURITY_SIGN_IN_MAX_FAILURES must be a whole number") {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("SUPERMIXER_SECURITY_SIGN_IN_MAX_FAILURES", "")
	os.Unsetenv("SUPERMIXER_SECURITY_SIGN_IN_MAX_FAILURES")

	_, err = Load(write(t, `
[server]
public_url = "not a url"
[appearance]
brand_color = "blue"
default_theme = "sepia"
[security]
encryption_key = "short"
session_ttl = "10s"
`), true)
	if err == nil {
		t.Fatal("expected validation errors")
	}
	for _, want := range []string{"server.public_url", "appearance.brand_color", "appearance.default_theme", "security.encryption_key", "security.session_ttl", "database.url"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

// The example file must stay complete and loadable.
func TestExampleFileCoversEverySetting(t *testing.T) {
	path := filepath.Join("..", "..", "..", ".env.example.toml")
	t.Setenv("SUPERMIXER_SECURITY_ENCRYPTION_KEY", validKey) // the example leaves it blank
	if _, err := Load(path, true); err != nil {
		t.Fatalf("example does not load: %v", err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	present := map[string]bool{}
	section := ""
	sec := regexp.MustCompile(`^\[([a-z0-9_.]+)\]`)
	key := regexp.MustCompile(`^([a-z_]+)\s*=`)
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if m := sec.FindStringSubmatch(line); m != nil {
			section = m[1]
		} else if m := key.FindStringSubmatch(line); m != nil {
			present[section+"."+m[1]] = true
		}
	}
	for k := range Keys() {
		if !present[k] {
			t.Errorf("%s is missing from .env.example.toml", k)
		}
	}
}

func TestBareNumberDurationsAreRejected(t *testing.T) {
	_, err := Load(write(t, minimal+"\n[projects]\nquery_timeout = 60\n"), true)
	if err == nil || !strings.Contains(err.Error(), `projects.query_timeout must be a quoted duration`) {
		t.Fatalf("err = %v", err)
	}
	_, err = Load(write(t, minimal+"\n[projects]\nquery_timeout = \"500us\"\n"), true)
	if err == nil || !strings.Contains(err.Error(), "projects.query_timeout must be at least 1ms") {
		t.Fatalf("err = %v", err)
	}
}

func TestDirectoryInsteadOfFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".env.toml")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SUPERMIXER_DATABASE_URL", "postgres://env@localhost/db")
	t.Setenv("SUPERMIXER_SECURITY_ENCRYPTION_KEY", validKey)
	cfg, err := Load(dir, false)
	if err != nil || len(cfg.Notes) != 1 {
		t.Fatalf("cfg = %+v, err = %v", cfg, err)
	}
	if _, err := Load(dir, true); err == nil {
		t.Fatal("an explicitly named directory should be an error")
	}
}

func TestHostNames(t *testing.T) {
	for host, ok := range map[string]bool{
		"localhost": true, "supabase.example.internal": true, "10.0.0.5": true, "::1": true, "[::1]": true,
		"[::1": false, "::1]": false, "-bad": false, "a b": false, "http://x": false, "": false,
	} {
		if hostName.MatchString(host) != ok {
			t.Errorf("%q: want valid=%v", host, ok)
		}
	}
}

func TestBackupS3(t *testing.T) {
	load := func(s3 string) error {
		_, err := Load(write(t, minimal+"\n[provisioning]\nenabled = true\n[provisioning.backup_s3]\n"+s3), true)
		return err
	}
	if err := load(`bucket = "my-backups"
endpoint = "https://s3.eu-west-1.amazonaws.com"
access_key_id = "AKIA"
secret_access_key = "s"`); err != nil {
		t.Fatalf("valid settings: %v", err)
	}
	if err := load(`bucket = ""`); err != nil {
		t.Fatalf("off: %v", err)
	}
	if err := load(`bucket = "backups.example.com"
endpoint = "https://s3.us-east-1.amazonaws.com"`); err == nil || !strings.Contains(err.Error(), "path_style") {
		t.Errorf("dotted bucket over https: %v", err)
	}
	if err := load(`bucket = "backups.example.com"
endpoint = "https://s3.us-east-1.amazonaws.com"
path_style = true`); err != nil {
		t.Errorf("dotted bucket, path style: %v", err)
	}
	err := load(`bucket = "My_Bucket"
endpoint = "s3.amazonaws.com"
prefix = "/a/"
access_key_id = "AKIA"`)
	for _, want := range []string{"backup_s3.bucket", "backup_s3.endpoint", "backup_s3.prefix", "both access_key_id"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

func TestOpsSettings(t *testing.T) {
	dir := t.TempDir()
	c, err := Load(write(t, minimal+`
[metrics]
listen = "127.0.0.1:9100"
[[audit.drains]]
id = "siem"
type = "http"
url = "https://siem.example.com/in"
headers = { Authorization = "Bearer x" }
[[audit.drains]]
id = "file"
type = "file"
path = "`+filepath.Join(dir, "audit.jsonl")+`"
`), true)
	if err != nil {
		t.Fatal(err)
	}
	if c.Metrics.Listen != "127.0.0.1:9100" || len(c.Audit.Drains) != 2 || c.Audit.Drains[0].Headers["Authorization"] != "Bearer x" {
		t.Fatalf("loaded %+v %+v", c.Metrics, c.Audit)
	}
	_, err = Load(write(t, minimal+`
[server]
listen = ":8080"
[metrics]
listen = "9100"
[[audit.drains]]
id = "Bad Id"
type = "http"
url = "siem.example.com"
[[audit.drains]]
id = "x"
type = "file"
path = "relative.jsonl"
[[audit.drains]]
id = "x"
type = "kafka"
[[audit.drains]]
id = "y"
type = "file"
path = "/no/such/folder/audit.jsonl"
`), true)
	for _, want := range []string{"metrics.listen", "audit.drains[0].id", "audit.drains[0].url", "audit.drains[1].path must be an absolute",
		"audit.drains[2].id \"x\" is used twice", "audit.drains[2].type", "audit.drains[3].path's folder"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

func TestMetricsPortClash(t *testing.T) {
	for listen, clash := range map[string]bool{":8080": true, "127.0.0.1:8080": true, "127.0.0.1:9100": false} {
		_, err := Load(write(t, minimal+"[server]\nlisten = \":8080\"\n[metrics]\nlisten = \""+listen+"\"\n"), true)
		if clash != (err != nil && strings.Contains(err.Error(), "different port")) {
			t.Errorf("metrics.listen %s: %v", listen, err)
		}
	}
}

// dev_web_url must be the Vite dev server, never this server: that would
// redirect every page to itself.
func TestDevWebURL(t *testing.T) {
	for value, ok := range map[string]bool{
		"http://localhost:5173":   true,
		"http://localhost:5173/":  true,
		"http://localhost:8080":   false, // public_url (and the listen port)
		"http://LOCALHOST:8080/":  false,
		"http://127.0.0.1:8080":   false, // the listen port
		"http://localhost:5173/x": false,
		"localhost:5173":          false,
	} {
		_, err := Load(write(t, minimal+`
[server]
listen = ":8080"
public_url = "http://localhost:8080"
dev_web_url = "`+value+`"
`), true)
		if (err == nil) != ok {
			t.Errorf("dev_web_url %q: err = %v", value, err)
		}
	}
}
