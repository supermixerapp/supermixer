// Package config loads Supermixer's settings from the environment, optionally
// seeded from a .env file. Real environment variables always win over values
// in the file, so deployments can override anything without editing it.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

// Config is the fully validated runtime configuration.
type Config struct {
	HTTPAddr  string `env:"SUPERMIXER_HTTP_ADDR" envDefault:":8080"`
	PublicURL string `env:"SUPERMIXER_PUBLIC_URL" envDefault:"http://localhost:8080"`

	DatabaseURL string `env:"SUPERMIXER_DATABASE_URL,required,notEmpty"`

	// EncryptionKey is a base64-encoded 32-byte key used to encrypt stored
	// project credentials (AES-256-GCM).
	EncryptionKey string `env:"SUPERMIXER_ENCRYPTION_KEY,required,notEmpty"`

	SessionTTL time.Duration `env:"SUPERMIXER_SESSION_TTL" envDefault:"168h"`

	// Temporary bootstrap admin. Replaced by proper admin management in Stage 5.
	BootstrapAdminUsername string `env:"SUPERMIXER_BOOTSTRAP_ADMIN_USERNAME" envDefault:"admin"`
	BootstrapAdminPassword string `env:"SUPERMIXER_BOOTSTRAP_ADMIN_PASSWORD" envDefault:"admin"`

	// BrandColor replaces Supabase's green throughout the UI.
	BrandColor   string `env:"BRAND_COLOR" envDefault:"#0019A8"`
	DefaultTheme string `env:"SUPERMIXER_DEFAULT_THEME" envDefault:"dark"`

	LogLevel string `env:"SUPERMIXER_LOG_LEVEL" envDefault:"info"`

	// TrustProxy takes client IPs from X-Forwarded-For / X-Real-IP. Enable
	// only behind a reverse proxy that sets them.
	TrustProxy bool `env:"SUPERMIXER_TRUST_PROXY" envDefault:"false"`
}

var hexColor = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

// Load reads envFile (if it exists) into the process environment without
// overriding variables that are already set, then parses and validates.
func Load(envFile string) (*Config, error) {
	if envFile != "" {
		if _, err := os.Stat(envFile); err == nil {
			if err := godotenv.Load(envFile); err != nil {
				return nil, fmt.Errorf("reading %s: %w", envFile, err)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("reading %s: %w", envFile, err)
		}
	}

	var cfg Config
	if err := env.Parse(&cfg); err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) validate() error {
	var errs []error

	if u, err := url.Parse(c.PublicURL); err != nil || u.Scheme == "" || u.Host == "" {
		errs = append(errs, fmt.Errorf("SUPERMIXER_PUBLIC_URL must be an absolute URL, got %q", c.PublicURL))
	}

	if key, err := base64.StdEncoding.DecodeString(c.EncryptionKey); err != nil || len(key) != 32 {
		errs = append(errs, errors.New("SUPERMIXER_ENCRYPTION_KEY must be 32 bytes, base64-encoded (generate one with: openssl rand -base64 32)"))
	}

	if c.SessionTTL < time.Minute {
		errs = append(errs, fmt.Errorf("SUPERMIXER_SESSION_TTL must be at least 1m, got %s", c.SessionTTL))
	}

	if strings.TrimSpace(c.BootstrapAdminUsername) == "" || c.BootstrapAdminPassword == "" {
		errs = append(errs, errors.New("SUPERMIXER_BOOTSTRAP_ADMIN_USERNAME and SUPERMIXER_BOOTSTRAP_ADMIN_PASSWORD must not be empty"))
	}

	if !hexColor.MatchString(c.BrandColor) {
		errs = append(errs, fmt.Errorf("BRAND_COLOR must be a hex colour like #0019A8, got %q", c.BrandColor))
	}

	switch c.DefaultTheme {
	case "dark", "light", "system":
	default:
		errs = append(errs, fmt.Errorf("SUPERMIXER_DEFAULT_THEME must be dark, light or system, got %q", c.DefaultTheme))
	}

	if _, err := c.SlogLevel(); err != nil {
		errs = append(errs, err)
	}

	return errors.Join(errs...)
}

// SlogLevel converts LogLevel to a slog.Level.
func (c *Config) SlogLevel() (slog.Level, error) {
	var l slog.Level
	if err := l.UnmarshalText([]byte(c.LogLevel)); err != nil {
		return 0, fmt.Errorf("SUPERMIXER_LOG_LEVEL must be debug, info, warn or error, got %q", c.LogLevel)
	}
	return l, nil
}
