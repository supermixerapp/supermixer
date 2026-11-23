// Package stack talks to one self-hosted Supabase stack: its API gateway
// (Envoy or Kong) and its Postgres database.
package stack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Keys are a stack's API keys. A stack has legacy JWT keys (anon,
// service_role), the newer opaque keys (sb_publishable_…, sb_secret_…), or both.
type Keys struct {
	Anon        string `json:"anon,omitempty"`
	ServiceRole string `json:"service_role,omitempty"`
	Publishable string `json:"publishable,omitempty"`
	Secret      string `json:"secret,omitempty"`
	JWTSecret   string `json:"jwt_secret,omitempty"`
}

// Public is the key browsers use (publishable preferred).
func (k Keys) Public() string {
	if k.Publishable != "" {
		return k.Publishable
	}
	return k.Anon
}

// Admin is the privileged key the gateway accepts for pg-meta and admin APIs.
// The legacy service_role key is preferred because the self-hosted gateway's
// /pg/ route matches it exactly.
func (k Keys) Admin() string {
	if k.ServiceRole != "" {
		return k.ServiceRole
	}
	return k.Secret
}

// Validate checks that a usable key pair is present.
func (k Keys) Validate() error {
	if k.Public() == "" {
		return errors.New("an anon key or a publishable key is required")
	}
	if k.Admin() == "" {
		return errors.New("a service_role key or a secret key is required")
	}
	return nil
}

// Database is how to reach the stack's Postgres (usually via Supavisor).
type Database struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Name     string `json:"name"`
	User     string `json:"user"`
	Password string `json:"-"`
	SSLMode  string `json:"sslmode"`
}

// SSLModes accepted for Database.SSLMode.
var SSLModes = []string{"disable", "prefer", "require", "verify-ca", "verify-full"}

// URI builds a postgres:// connection string. With withPassword false, the
// password is replaced by a placeholder, for display.
func (d Database) URI(withPassword bool) string {
	u := url.URL{
		Scheme: "postgresql",
		Host:   net.JoinHostPort(d.Host, strconv.Itoa(d.Port)),
		Path:   "/" + d.Name,
	}
	if withPassword {
		u.User = url.UserPassword(d.User, d.Password)
	} else {
		u.User = url.User(d.User)
	}
	q := url.Values{}
	if d.SSLMode != "" {
		q.Set("sslmode", d.SSLMode)
	}
	u.RawQuery = q.Encode()
	s := u.String()
	if !withPassword {
		s = strings.Replace(s, "@", ":[YOUR-PASSWORD]@", 1)
	}
	return s
}

// Login is a database user and password.
type Login struct {
	User     string `json:"user"`
	Password string `json:"password"`
}

// As returns the same database reached as another user.
func (d Database) As(l Login) Database {
	d.User, d.Password = l.User, l.Password
	return d
}

// Connection is everything needed to reach a stack.
type Connection struct {
	APIURL   string
	Database Database
	Keys     Keys
	// ReadOnly, when set, is a low-privilege login that read-only queries
	// use instead of Database's user (see CreateReadOnlyUser).
	ReadOnly *Login
}

// NormalizeAPIURL validates an http(s) URL and strips a trailing slash.
func NormalizeAPIURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("%q is not an http(s) URL", raw)
	}
	u.RawQuery, u.Fragment = "", ""
	return strings.TrimRight(u.String(), "/"), nil
}

// CheckStatus is the outcome of one service check.
type CheckStatus string

const (
	StatusOK    CheckStatus = "ok"
	StatusError CheckStatus = "error"
)

// ServiceCheck is one service's health.
type ServiceCheck struct {
	Service   string      `json:"service"`
	Label     string      `json:"label"`
	Status    CheckStatus `json:"status"`
	LatencyMS int64       `json:"latency_ms"`
	Detail    string      `json:"detail,omitempty"`
}

// Overall stack status.
const (
	Healthy   = "healthy"
	Degraded  = "degraded"
	Unhealthy = "unhealthy"
)

// Report summarises a stack's health.
type Report struct {
	Status          string         `json:"status"`
	Services        []ServiceCheck `json:"services"`
	PostgresVersion string         `json:"postgres_version,omitempty"`
	AuthVersion     string         `json:"auth_version,omitempty"`
	CheckedAt       time.Time      `json:"checked_at"`
}

// Checker runs health checks. The zero value is not usable; use NewChecker.
type Checker struct {
	client  *http.Client
	timeout time.Duration
}

// NewChecker returns a Checker with per-check timeout.
func NewChecker(timeout time.Duration) *Checker {
	return &Checker{
		client: &http.Client{
			Timeout: timeout,
			// A redirect from the gateway usually means a wrong URL; report it.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		timeout: timeout,
	}
}

// Check probes Auth, REST, Storage and pg-meta through the gateway, and
// Postgres directly, in parallel.
func (c *Checker) Check(ctx context.Context, conn Connection) Report {
	type result struct {
		idx     int
		check   ServiceCheck
		version string
	}
	probes := []struct {
		service, label string
		run            func(context.Context) (string, error)
	}{
		{"auth", "Auth", func(ctx context.Context) (string, error) {
			var body struct {
				Version string `json:"version"`
			}
			err := c.getJSON(ctx, conn.APIURL+"/auth/v1/health", conn.Keys.Public(), &body)
			return body.Version, err
		}},
		{"rest", "Data API (PostgREST)", func(ctx context.Context) (string, error) {
			return "", c.getJSON(ctx, conn.APIURL+"/rest/v1/", conn.Keys.Admin(), nil)
		}},
		{"storage", "Storage", func(ctx context.Context) (string, error) {
			return "", c.getJSON(ctx, conn.APIURL+"/storage/v1/status", conn.Keys.Public(), nil)
		}},
		{"meta", "Postgres Meta", func(ctx context.Context) (string, error) {
			return "", c.getJSON(ctx, conn.APIURL+"/pg/config/version", conn.Keys.Admin(), nil)
		}},
		{"database", "Database", func(ctx context.Context) (string, error) {
			return c.postgresVersion(ctx, conn.Database)
		}},
	}

	results := make([]result, len(probes))
	var wg sync.WaitGroup
	for i, p := range probes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pctx, cancel := context.WithTimeout(ctx, c.timeout)
			defer cancel()
			start := time.Now()
			version, err := p.run(pctx)
			check := ServiceCheck{Service: p.service, Label: p.label, Status: StatusOK, LatencyMS: time.Since(start).Milliseconds()}
			if err != nil {
				check.Status = StatusError
				check.Detail = Describe(err)
			}
			results[i] = result{i, check, version}
		}()
	}
	wg.Wait()

	report := Report{CheckedAt: time.Now().UTC()}
	failed := 0
	for _, r := range results {
		report.Services = append(report.Services, r.check)
		if r.check.Status != StatusOK {
			failed++
			continue
		}
		switch r.check.Service {
		case "database":
			report.PostgresVersion = r.version
		case "auth":
			report.AuthVersion = r.version
		}
	}
	switch {
	case failed == 0:
		report.Status = Healthy
	case failed == len(results) || results[len(results)-1].check.Status != StatusOK:
		// Without the database nothing works.
		report.Status = Unhealthy
	default:
		report.Status = Degraded
	}
	return report
}

type httpError struct {
	status int
	body   string
}

func (e *httpError) Error() string {
	switch e.status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Sprintf("HTTP %d: the gateway rejected the API key", e.status)
	case http.StatusNotFound:
		return "HTTP 404: route not found; check the API URL points at the Supabase gateway"
	}
	if e.body != "" {
		return fmt.Sprintf("HTTP %d: %s", e.status, e.body)
	}
	return fmt.Sprintf("HTTP %d", e.status)
}

func (c *Checker) getJSON(ctx context.Context, url, key string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("apikey", key)
	// Legacy keys are JWTs and also go in Authorization; new sb_ keys must not.
	if strings.Count(key, ".") == 2 {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > 120 {
			snippet = snippet[:120] + "…"
		}
		return &httpError{status: resp.StatusCode, body: snippet}
	}
	if out != nil {
		_ = json.Unmarshal(body, out)
	}
	return nil
}

func (c *Checker) postgresVersion(ctx context.Context, d Database) (string, error) {
	cfg, err := pgx.ParseConfig(d.URI(true))
	if err != nil {
		return "", err
	}
	cfg.ConnectTimeout = c.timeout
	cfg.RuntimeParams["application_name"] = "supermixer"
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return "", err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	var version string
	err = conn.QueryRow(ctx, "SELECT current_setting('server_version')").Scan(&version)
	return version, err
}

// describe turns low-level errors into something an operator can act on.
// Describe turns a connection error into a short, user-facing reason.
func Describe(err error) string {
	var he *httpError
	if errors.As(err, &he) {
		return he.Error()
	}
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		return "timed out"
	}
	msg := err.Error()
	if strings.Contains(msg, "connection refused") {
		return "connection refused; is the stack running and the address right?"
	}
	if strings.Contains(msg, "no such host") {
		return "host not found"
	}
	if strings.Contains(msg, "password authentication failed") {
		return "password authentication failed"
	}
	return msg
}
