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
	if cfg.Appearance.BrandColor != "#0019A8" || cfg.Server.Listen != ":8080" || cfg.Appearance.DefaultTheme != "dark" {
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
	sec := regexp.MustCompile(`^\[([a-z_.]+)\]`)
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
