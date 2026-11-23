package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // 32 bytes

func setEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoadDefaults(t *testing.T) {
	setEnv(t, map[string]string{
		"SUPERMIXER_DATABASE_URL":   "postgres://x@localhost/db",
		"SUPERMIXER_ENCRYPTION_KEY": validKey,
	})
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.BrandColor != "#0019A8" {
		t.Errorf("BrandColor = %q, want #0019A8", cfg.BrandColor)
	}
	if cfg.HTTPAddr != ":8080" || cfg.DefaultTheme != "dark" {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
}

func TestLoadEnvFileDoesNotOverrideRealEnv(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, ".env")
	content := "SUPERMIXER_DATABASE_URL=postgres://file@localhost/db\nSUPERMIXER_ENCRYPTION_KEY=" + validKey + "\nBRAND_COLOR=#123456\n"
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	// Real env wins; t.Setenv restores the previous value afterwards.
	t.Setenv("BRAND_COLOR", "#abcdef")
	// Make sure values from the file are cleaned up after the test.
	t.Setenv("SUPERMIXER_DATABASE_URL", "")
	os.Unsetenv("SUPERMIXER_DATABASE_URL")
	t.Setenv("SUPERMIXER_ENCRYPTION_KEY", "")
	os.Unsetenv("SUPERMIXER_ENCRYPTION_KEY")

	cfg, err := Load(file)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.BrandColor != "#abcdef" {
		t.Errorf("BrandColor = %q, want the real env value #abcdef", cfg.BrandColor)
	}
	if cfg.DatabaseURL != "postgres://file@localhost/db" {
		t.Errorf("DatabaseURL = %q, want value from file", cfg.DatabaseURL)
	}
}

func TestLoadValidation(t *testing.T) {
	cases := map[string]struct {
		env  map[string]string
		want string
	}{
		"bad key":    {map[string]string{"SUPERMIXER_ENCRYPTION_KEY": "c2hvcnQ="}, "SUPERMIXER_ENCRYPTION_KEY"},
		"bad colour": {map[string]string{"BRAND_COLOR": "blue"}, "BRAND_COLOR"},
		"bad theme":  {map[string]string{"SUPERMIXER_DEFAULT_THEME": "purple"}, "SUPERMIXER_DEFAULT_THEME"},
		"bad level":  {map[string]string{"SUPERMIXER_LOG_LEVEL": "loud"}, "SUPERMIXER_LOG_LEVEL"},
		"bad url":    {map[string]string{"SUPERMIXER_PUBLIC_URL": "localhost"}, "SUPERMIXER_PUBLIC_URL"},
		"short ttl":  {map[string]string{"SUPERMIXER_SESSION_TTL": "5s"}, "SUPERMIXER_SESSION_TTL"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			setEnv(t, map[string]string{
				"SUPERMIXER_DATABASE_URL":   "postgres://x@localhost/db",
				"SUPERMIXER_ENCRYPTION_KEY": validKey,
			})
			setEnv(t, tc.env)
			_, err := Load("")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want mention of %s", err, tc.want)
			}
		})
	}
}

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("SUPERMIXER_DATABASE_URL", "")
	t.Setenv("SUPERMIXER_ENCRYPTION_KEY", validKey)
	if _, err := Load(""); err == nil {
		t.Fatal("expected error for missing SUPERMIXER_DATABASE_URL")
	}
}
