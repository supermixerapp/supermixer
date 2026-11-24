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
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
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
	Provisioning   Provisioning   `toml:"provisioning"`
	Email          Email          `toml:"email"`
}

// Email is how Supermixer sends email: invitations, password-reset links and
// security notices. Off while smtp_host is empty.
type Email struct {
	SMTPHost string `toml:"smtp_host"`
	SMTPPort int    `toml:"smtp_port"`
	// Security is starttls (upgrade the connection; port 587), tls (TLS
	// from the start; port 465) or none (a relay on the same host or a
	// trusted network only).
	Security string `toml:"security"`
	// Username and Password sign in to the server; leave both empty for a
	// relay that doesn't ask.
	Username string `toml:"username"`
	Password string `toml:"password"`
	// From is the sender, like "Supermixer <supermixer@example.com>".
	From    string        `toml:"from"`
	Timeout time.Duration `toml:"timeout"`
}

// Enabled reports whether Supermixer sends email.
func (e Email) Enabled() bool { return e.SMTPHost != "" }

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

// BootstrapAdmin is created on first start when there are no users. It
// must choose a new password when it first signs in.
type BootstrapAdmin struct {
	Username string `toml:"username"`
	// Password is the first sign-in's; empty generates a one-time password
	// and logs it.
	Password string `toml:"password"`
}

type Appearance struct {
	// BrandColor replaces Supabase's green throughout the UI.
	BrandColor   string `toml:"brand_color"`
	DefaultTheme string `toml:"default_theme"` // dark | light | system; for users who haven't chosen
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

// Provisioning lets Supermixer create Supabase stacks itself, with the
// docker compose CLI. It is off unless enabled: driving Docker is
// root-equivalent on the host.
type Provisioning struct {
	Enabled bool `toml:"enabled"`
	// StacksDir holds one folder per stack. Compose resolves the stacks' bind
	// mounts on the Docker host, so when Supermixer runs in a container this
	// folder must be mounted at the same path inside it.
	StacksDir string `toml:"stacks_dir"`
	// Docker is the docker CLI to run (with the compose plugin).
	Docker string `toml:"docker"`
	// PublicHost is the host name in stacks' URLs, as users reach them.
	PublicHost string `toml:"public_host"`
	// ConnectHost is how Supermixer itself reaches the stacks' ports; empty
	// means public_host. In a container, host.docker.internal or the host's IP.
	ConnectHost string `toml:"connect_host"`
	// Host port ranges, "first-last", each stack taking one port from each.
	APIPorts    string `toml:"api_ports"`
	DBPorts     string `toml:"db_ports"`
	PoolerPorts string `toml:"pooler_ports"`
	// StartTimeout bounds creating or starting a stack, image pulls included.
	StartTimeout time.Duration `toml:"start_timeout"`
	// BackupsDir holds the stacks' database backups, one folder per stack.
	// Only Supermixer writes it (dumps stream out of the db container).
	BackupsDir string `toml:"backups_dir"`
	// BackupInterval is how often each running stack is backed up; 0 turns
	// scheduled backups off (manual ones still work).
	BackupInterval time.Duration `toml:"backup_interval"`
	// BackupKeep is how many scheduled backups to keep per stack.
	BackupKeep int `toml:"backup_keep"`
	// BackupS3 copies backups to an S3-compatible bucket as well.
	BackupS3 BackupS3 `toml:"backup_s3"`
}

// BackupS3 is a bucket backups are copied to (AWS S3, MinIO, Cloudflare R2,
// ...). It's off while Bucket is empty.
type BackupS3 struct {
	Bucket string `toml:"bucket"`
	// Endpoint is the service's URL, such as https://s3.us-east-1.amazonaws.com.
	Endpoint string `toml:"endpoint"`
	Region   string `toml:"region"`
	// Prefix starts every object's key: <prefix>/<project ref>/<backup id>/.
	Prefix string `toml:"prefix"`
	// Without an access key, the AWS environment variables or the host's
	// IAM role are used.
	AccessKeyID     string `toml:"access_key_id"`
	SecretAccessKey string `toml:"secret_access_key"`
	// PathStyle puts the bucket in the URL's path (MinIO, most other
	// services) rather than its host name (AWS).
	PathStyle bool `toml:"path_style"`
	// KeepLocal keeps backups in backups_dir after they're copied; off, they
	// stay only in the bucket, and restores and downloads fetch them from it.
	KeepLocal bool `toml:"keep_local"`
}

// Enabled reports whether backups are copied to a bucket.
func (s BackupS3) Enabled() bool { return s.Bucket != "" }

// PortRange is an inclusive range of host ports.
type PortRange struct{ First, Last int }

// ParsePortRange reads "first-last".
func ParsePortRange(s string) (PortRange, error) {
	a, b, ok := strings.Cut(strings.TrimSpace(s), "-")
	first, err1 := strconv.Atoi(strings.TrimSpace(a))
	last, err2 := strconv.Atoi(strings.TrimSpace(b))
	if !ok || err1 != nil || err2 != nil || first < 1024 || last > 65535 || first > last {
		return PortRange{}, fmt.Errorf("%q isn't a port range like 8200-8299 (ports 1024-65535)", s)
	}
	return PortRange{first, last}, nil
}

func (r PortRange) overlaps(o PortRange) bool { return r.First <= o.Last && o.First <= r.Last }

// Default returns the settings used for anything the file leaves out.
func Default() Config {
	return Config{
		Server:         Server{Listen: ":8080", PublicURL: "http://localhost:8080"},
		Log:            Log{Level: "info", Format: "text"},
		Security:       Security{SessionTTL: 168 * time.Hour, SignIn: SignIn{MaxFailures: 10, Lockout: 15 * time.Minute}},
		BootstrapAdmin: BootstrapAdmin{Username: "admin"},
		Appearance:     Appearance{BrandColor: "#0019A8", DefaultTheme: "light"},
		Projects: Projects{
			HealthCheckTimeout: 5 * time.Second, HealthCacheTTL: 15 * time.Second,
			QueryTimeout: 60 * time.Second, QueryMaxRows: 1000, DBPoolSize: 4, GatewayTimeout: 60 * time.Second,
		},
		Provisioning: Provisioning{
			StacksDir: "/var/lib/supermixer/stacks", Docker: "docker", PublicHost: "localhost",
			APIPorts: "8200-8299", DBPorts: "54400-54499", PoolerPorts: "64400-64499", StartTimeout: 20 * time.Minute,
			BackupsDir: "/var/lib/supermixer/backups", BackupInterval: 24 * time.Hour, BackupKeep: 7,
			BackupS3: BackupS3{Prefix: "supermixer", KeepLocal: true},
		},
		Email: Email{SMTPPort: 587, Security: "starttls", Timeout: 15 * time.Second},
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

var s3Bucket = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

var hexColor = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

// A DNS name or IPv4 address, or an IPv6 address with both brackets or neither.
var hostName = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[[0-9a-fA-F:]+\]$|^[0-9a-fA-F:]*:[0-9a-fA-F:]*$`)

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
	if e := c.Email; e.Enabled() {
		if e.SMTPPort < 1 || e.SMTPPort > 65535 {
			fail("email.smtp_port must be 1-65535, got %d", e.SMTPPort)
		}
		switch e.Security {
		case "starttls", "tls", "none":
		default:
			fail("email.security must be starttls, tls or none, got %q", e.Security)
		}
		if (e.Username == "") != (e.Password == "") {
			fail("email needs both username and password, or neither")
		}
		if e.Username != "" && e.Security == "none" {
			fail("email.security = \"none\" would send the password unencrypted; use starttls or tls")
		}
		if a, err := mail.ParseAddress(e.From); err != nil || strings.ContainsAny(a.Address, "\r\n") {
			fail("email.from must be an address like \"Supermixer <supermixer@example.com>\", got %q", e.From)
		}
		if e.Timeout <= 0 {
			fail("email.timeout must be positive, got %s", e.Timeout)
		}
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
	if strings.TrimSpace(c.BootstrapAdmin.Username) == "" {
		fail("bootstrap_admin.username must not be empty")
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
	if pv := c.Provisioning; pv.Enabled {
		if !filepath.IsAbs(pv.StacksDir) {
			fail("provisioning.stacks_dir must be an absolute path, got %q", pv.StacksDir)
		}
		if strings.TrimSpace(pv.Docker) == "" {
			fail("provisioning.docker must name the docker CLI")
		}
		if !hostName.MatchString(pv.PublicHost) {
			fail("provisioning.public_host must be a host name or IP address, got %q", pv.PublicHost)
		}
		if pv.ConnectHost != "" && !hostName.MatchString(pv.ConnectHost) {
			fail("provisioning.connect_host must be a host name or IP address, got %q", pv.ConnectHost)
		}
		if pv.StartTimeout < time.Minute {
			fail("provisioning.start_timeout must be at least 1m, got %s", pv.StartTimeout)
		}
		if !filepath.IsAbs(pv.BackupsDir) {
			fail("provisioning.backups_dir must be an absolute path, got %q", pv.BackupsDir)
		}
		if pv.BackupInterval != 0 && pv.BackupInterval < time.Hour {
			fail("provisioning.backup_interval must be 0 (off) or at least 1h, got %s", pv.BackupInterval)
		}
		if pv.BackupKeep < 1 || pv.BackupKeep > 1000 {
			fail("provisioning.backup_keep must be between 1 and 1000, got %d", pv.BackupKeep)
		}
		if s3 := pv.BackupS3; s3.Enabled() {
			if !s3Bucket.MatchString(s3.Bucket) {
				fail("provisioning.backup_s3.bucket must be a bucket name (3-63 lowercase letters, digits, dots and hyphens), got %q", s3.Bucket)
			}
			if u, err := url.Parse(s3.Endpoint); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
				(u.Path != "" && u.Path != "/") || u.User != nil || u.RawQuery != "" {
				fail("provisioning.backup_s3.endpoint must be a URL like https://s3.us-east-1.amazonaws.com, got %q", s3.Endpoint)
			}
			if strings.HasPrefix(s3.Prefix, "/") || strings.HasSuffix(s3.Prefix, "/") || strings.Contains(s3.Prefix, "//") ||
				strings.Contains("/"+s3.Prefix+"/", "/../") {
				fail("provisioning.backup_s3.prefix must be like supermixer or backups/supermixer (no leading or trailing /), got %q", s3.Prefix)
			}
			if strings.Contains(s3.Bucket, ".") && !s3.PathStyle && strings.HasPrefix(s3.Endpoint, "https:") {
				// bucket.with.dots.s3.amazonaws.com doesn't match AWS's *.s3.amazonaws.com certificate.
				fail("provisioning.backup_s3.bucket %q has dots, which don't work over HTTPS in the host name; set path_style = true", s3.Bucket)
			}
			if (s3.AccessKeyID == "") != (s3.SecretAccessKey == "") {
				fail("provisioning.backup_s3 needs both access_key_id and secret_access_key, or neither (to use the AWS environment or IAM role)")
			}
		}
		ranges := map[string]PortRange{}
		for name, raw := range map[string]string{"api_ports": pv.APIPorts, "db_ports": pv.DBPorts, "pooler_ports": pv.PoolerPorts} {
			r, err := ParsePortRange(raw)
			if err != nil {
				fail("provisioning.%s: %v", name, err)
				continue
			}
			ranges[name] = r
		}
		names := []string{"api_ports", "db_ports", "pooler_ports"}
		for i, a := range names {
			for _, b := range names[i+1:] {
				if ra, ok := ranges[a]; ok {
					if rb, ok := ranges[b]; ok && ra.overlaps(rb) {
						fail("provisioning.%s and provisioning.%s overlap", a, b)
					}
				}
			}
		}
	}
	sort.Slice(errs, func(i, j int) bool { return errs[i].Error() < errs[j].Error() })
	return errors.Join(errs...)
}

// StackHost is how Supermixer reaches the stacks it creates.
func (p Provisioning) StackHost() string {
	if p.ConnectHost != "" {
		return p.ConnectHost
	}
	return p.PublicHost
}

// SlogLevel converts log.level to a slog.Level.
func (c *Config) SlogLevel() (slog.Level, error) {
	var l slog.Level
	if err := l.UnmarshalText([]byte(c.Log.Level)); err != nil {
		return 0, fmt.Errorf("log.level must be debug, info, warn or error, got %q", c.Log.Level)
	}
	return l, nil
}
