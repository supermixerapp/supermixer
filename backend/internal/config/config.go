// Package config loads Supermixer's settings from a TOML file (.env.toml by
// default). Any setting can be overridden by an environment variable named
// after its key, SUPERMIXER_<SECTION>_<KEY> (database.url →
// SUPERMIXER_DATABASE_URL), so containers can inject secrets without
// editing the file. Unknown keys are an error, so typos don't go unnoticed.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the fully validated runtime configuration.
type Config struct {
	// Notes are warnings found while loading, for the caller to log once
	// logging is set up.
	Notes []string `toml:"-"`

	Server         Server         `toml:"server"`
	Log            Log            `toml:"log"`
	Database       Database       `toml:"database"`
	Security       Security       `toml:"security"`
	BootstrapAdmin BootstrapAdmin `toml:"bootstrap_admin"`
	Appearance     Appearance     `toml:"appearance"`
	Projects       Projects       `toml:"projects"`
}

type Server struct {
	// Listen is the address the HTTP server binds, e.g. ":8080".
	Listen string `toml:"listen"`
	// PublicURL is where users reach Supermixer (invitation links, cookies).
	PublicURL string `toml:"public_url"`
	// TrustProxy takes client IPs from X-Forwarded-For / X-Real-IP. Enable
	// only behind a reverse proxy that sets them.
	TrustProxy bool `toml:"trust_proxy"`
}

type Log struct {
	Level  string `toml:"level"`  // debug | info | warn | error
	Format string `toml:"format"` // text | json
}

type Database struct {
	URL string `toml:"url"`
	// MaxConnections caps Supermixer's own pool; 0 uses pgx's default.
	MaxConnections int `toml:"max_connections"`
}

type Security struct {
	// EncryptionKey is a base64-encoded 32-byte key that encrypts stored
	// project credentials (AES-256-GCM).
	EncryptionKey string        `toml:"encryption_key"`
	SessionTTL    time.Duration `toml:"session_ttl"`
	SignIn        SignIn        `toml:"sign_in"`
}

// SignIn limits password guessing, per client IP and per username.
type SignIn struct {
	MaxFailures int           `toml:"max_failures"`
	Lockout     time.Duration `toml:"lockout"`
}

// BootstrapAdmin is created on first start when there are no users.
type BootstrapAdmin struct {
	Username string `toml:"username"`
	Password string `toml:"password"`
}

type Appearance struct {
	// BrandColor replaces Supabase's green throughout the UI.
	BrandColor   string `toml:"brand_color"`
	DefaultTheme string `toml:"default_theme"` // dark | light | system
}

// Projects tunes how Supermixer talks to the Supabase stacks it manages.
type Projects struct {
	HealthCheckTimeout time.Duration `toml:"health_check_timeout"`
	HealthCacheTTL     time.Duration `toml:"health_cache_ttl"`
	QueryTimeout       time.Duration `toml:"query_timeout"`
	// QueryMaxRows is how many rows a query returns unless the caller asks
	// for a different number (the API allows up to 10000).
	QueryMaxRows int `toml:"query_max_rows"`
	// DBPoolSize is the number of connections kept per project database.
	DBPoolSize     int           `toml:"db_pool_size"`
	GatewayTimeout time.Duration `toml:"gateway_timeout"`
}

// Default returns the settings used for anything the file leaves out.
func Default() Config {
	return Config{
		Server:         Server{Listen: ":8080", PublicURL: "http://localhost:8080"},
		Log:            Log{Level: "info", Format: "text"},
		Security:       Security{SessionTTL: 168 * time.Hour, SignIn: SignIn{MaxFailures: 10, Lockout: 15 * time.Minute}},
		BootstrapAdmin: BootstrapAdmin{Username: "admin", Password: "admin"},
		Appearance:     Appearance{BrandColor: "#0019A8", DefaultTheme: "dark"},
		Projects: Projects{
			HealthCheckTimeout: 5 * time.Second, HealthCacheTTL: 15 * time.Second,
			QueryTimeout: 60 * time.Second, QueryMaxRows: 1000, DBPoolSize: 4, GatewayTimeout: 60 * time.Second,
		},
	}
}

// EnvPrefix starts every override variable.
const EnvPrefix = "SUPERMIXER_"

// Load reads path over the defaults, applies environment overrides and
// validates. A missing file is fine unless required is set (the path was
// given explicitly); everything can then come from the environment.
func Load(path string, required bool) (*Config, error) {
	cfg := Default()
	if path != "" {
		info, statErr := os.Stat(path)
		switch {
		case statErr == nil && info.IsDir():
			// Docker creates a directory when bind-mounting a missing file.
			if required {
				return nil, fmt.Errorf("%s is a directory, not a TOML file", path)
			}
			cfg.Notes = append(cfg.Notes, path+" is a directory, not a TOML file; ignoring it")
		case errors.Is(statErr, os.ErrNotExist) && !required:
		default:
			md, err := toml.DecodeFile(path, &cfg)
			if err != nil {
				return nil, fmt.Errorf("reading %s: %w", path, err)
			}
			if err := checkDecoded(path, md); err != nil {
				return nil, err
			}
		}
	}
	if err := applyEnv(reflect.ValueOf(&cfg).Elem(), nil, os.LookupEnv); err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// checkDecoded rejects unknown keys and durations written as bare numbers
// (TOML would read query_timeout = 60 as 60 nanoseconds).
func checkDecoded(path string, md toml.MetaData) error {
	if extra := md.Undecoded(); len(extra) > 0 {
		keys := make([]string, len(extra))
		for i, k := range extra {
			keys[i] = k.String()
		}
		sort.Strings(keys)
		return fmt.Errorf("%s: unknown setting(s): %s", path, strings.Join(keys, ", "))
	}
	var errs []error
	for key := range durationKeys() {
		parts := strings.Split(key, ".")
		if md.IsDefined(parts...) && md.Type(parts...) != "String" {
			errs = append(errs, fmt.Errorf("%s: %s must be a quoted duration like \"60s\" or \"15m\"", path, key))
		}
	}
	sort.Slice(errs, func(i, j int) bool { return errs[i].Error() < errs[j].Error() })
	return errors.Join(errs...)
}

func durationKeys() map[string]bool {
	out := map[string]bool{}
	walkFields(reflect.TypeOf(Config{}), nil, func(f reflect.StructField, path []string) {
		if f.Type == durationType {
			out[strings.Join(path, ".")] = true
		}
	})
	return out
}

// walkFields visits every setting (leaf field with a toml tag).
func walkFields(t reflect.Type, path []string, visit func(f reflect.StructField, path []string)) {
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("toml")
		if tag == "" || tag == "-" {
			continue
		}
		p := append(append([]string{}, path...), tag)
		if f.Type.Kind() == reflect.Struct && f.Type != durationType {
			walkFields(f.Type, p, visit)
			continue
		}
		visit(f, p)
	}
}

// EnvName is the override variable for a dotted key path.
func EnvName(path []string) string {
	return EnvPrefix + strings.ToUpper(strings.Join(path, "_"))
}

// Keys lists every setting as "section.key" with its variable, for docs and tests.
func Keys() map[string]string {
	out := map[string]string{}
	walkFields(reflect.TypeOf(Config{}), nil, func(_ reflect.StructField, path []string) {
		out[strings.Join(path, ".")] = EnvName(path)
	})
	return out
}

var durationType = reflect.TypeOf(time.Duration(0))

func applyEnv(v reflect.Value, path []string, lookup func(string) (string, bool)) error {
	var errs []error
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("toml")
		if tag == "" || tag == "-" {
			continue
		}
		p := append(append([]string{}, path...), tag)
		fv := v.Field(i)
		if f.Type.Kind() == reflect.Struct {
			if err := applyEnv(fv, p, lookup); err != nil {
				errs = append(errs, err)
			}
			continue
		}
		name := EnvName(p)
		raw, ok := lookup(name)
		if !ok {
			continue
		}
		bad := func(want string) {
			errs = append(errs, fmt.Errorf("%s must be %s, got %q", name, want, raw))
		}
		switch {
		case f.Type == durationType:
			d, err := time.ParseDuration(raw)
			if err != nil {
				bad("a duration like 15m or 168h")
				continue
			}
			fv.SetInt(int64(d))
		case f.Type.Kind() == reflect.String:
			fv.SetString(raw)
		case f.Type.Kind() == reflect.Bool:
			b, err := strconv.ParseBool(raw)
			if err != nil {
				bad("true or false")
				continue
			}
			fv.SetBool(b)
		case f.Type.Kind() == reflect.Int:
			n, err := strconv.Atoi(raw)
			if err != nil {
				bad("a whole number")
				continue
			}
			fv.SetInt(int64(n))
		default:
			errs = append(errs, fmt.Errorf("%s: unsupported setting type %s", name, f.Type))
		}
	}
	return errors.Join(errs...)
}

var hexColor = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

func (c *Config) validate() error {
	var errs []error
	fail := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if c.Server.Listen == "" {
		fail("server.listen must not be empty")
	}
	if u, err := url.Parse(c.Server.PublicURL); err != nil || u.Scheme == "" || u.Host == "" {
		fail("server.public_url must be an absolute URL, got %q", c.Server.PublicURL)
	}
	if _, err := c.SlogLevel(); err != nil {
		errs = append(errs, err)
	}
	if c.Log.Format != "text" && c.Log.Format != "json" {
		fail("log.format must be text or json, got %q", c.Log.Format)
	}
	if c.Database.URL == "" {
		fail("database.url is required (or set %s)", EnvName([]string{"database", "url"}))
	}
	if c.Database.MaxConnections < 0 {
		fail("database.max_connections must not be negative")
	}
	if c.Security.EncryptionKey == "" {
		fail("security.encryption_key is required (generate one with: openssl rand -base64 32)")
	} else if key, err := base64.StdEncoding.DecodeString(c.Security.EncryptionKey); err != nil || len(key) != 32 {
		fail("security.encryption_key must be 32 bytes, base64-encoded (generate one with: openssl rand -base64 32)")
	}
	if c.Security.SessionTTL < time.Minute {
		fail("security.session_ttl must be at least 1m, got %s", c.Security.SessionTTL)
	}
	if c.Security.SignIn.MaxFailures < 1 || c.Security.SignIn.Lockout < time.Second {
		fail("security.sign_in needs max_failures ≥ 1 and lockout ≥ 1s")
	}
	if strings.TrimSpace(c.BootstrapAdmin.Username) == "" || c.BootstrapAdmin.Password == "" {
		fail("bootstrap_admin.username and bootstrap_admin.password must not be empty")
	}
	if !hexColor.MatchString(c.Appearance.BrandColor) {
		fail("appearance.brand_color must be a hex colour like #0019A8, got %q", c.Appearance.BrandColor)
	}
	switch c.Appearance.DefaultTheme {
	case "dark", "light", "system":
	default:
		fail("appearance.default_theme must be dark, light or system, got %q", c.Appearance.DefaultTheme)
	}
	p := c.Projects
	for name, d := range map[string]time.Duration{
		"health_check_timeout": p.HealthCheckTimeout, "health_cache_ttl": p.HealthCacheTTL,
		"query_timeout": p.QueryTimeout, "gateway_timeout": p.GatewayTimeout,
	} {
		if d < time.Millisecond {
			fail("projects.%s must be at least 1ms, got %s", name, d)
		}
	}
	if p.QueryMaxRows < 1 || p.QueryMaxRows > 10000 {
		fail("projects.query_max_rows must be between 1 and 10000, got %d", p.QueryMaxRows)
	}
	if p.DBPoolSize < 1 || p.DBPoolSize > 100 {
		fail("projects.db_pool_size must be between 1 and 100, got %d", p.DBPoolSize)
	}
	sort.Slice(errs, func(i, j int) bool { return errs[i].Error() < errs[j].Error() })
	return errors.Join(errs...)
}

// SlogLevel converts log.level to a slog.Level.
func (c *Config) SlogLevel() (slog.Level, error) {
	var l slog.Level
	if err := l.UnmarshalText([]byte(c.Log.Level)); err != nil {
		return 0, fmt.Errorf("log.level must be debug, info, warn or error, got %q", c.Log.Level)
	}
	return l, nil
}
