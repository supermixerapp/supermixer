package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const healthy = `{"status":"healthy","version":"v1.2.3","database":{"status":"healthy","schema_version":42,"installed_at":"2026-07-01T10:00:00Z"}}`
const unhealthy = `{"status":"unhealthy","version":"v1.2.3","database":{"status":"unhealthy","error":"database unavailable"}}`

// server answers /api/v1/health with the given status and body.
func server(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.Close)
	return s
}

func mixer(t *testing.T, vars map[string]string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errb bytes.Buffer
	code = run(context.Background(), args, env{func(k string) string { return vars[k] }, &out, &errb})
	return code, out.String(), errb.String()
}

// fields reads "key value" lines into a map, as awk would.
func fields(s string) map[string]string {
	m := map[string]string{}
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		k, v, _ := strings.Cut(l, " ")
		m[k] = strings.TrimSpace(v)
	}
	return m
}

func TestHealthy(t *testing.T) {
	s := server(t, 200, healthy)
	code, out, errb := mixer(t, nil, "--server", s.URL, "health")
	if code != exitOK || errb != "" {
		t.Fatalf("code %d, stderr %q", code, errb)
	}
	f := fields(out)
	for k, want := range map[string]string{
		"status": "healthy", "version": "v1.2.3", "database": "healthy", "schema_version": "42",
		"installed_at": "2026-07-01T10:00:00Z", "server": s.URL, "http_status": "200", "protocol": "HTTP/1.1",
	} {
		if f[k] != want {
			t.Errorf("%s = %q, want %q\n%s", k, f[k], want, out)
		}
	}
	for _, k := range []string{"address", "connect", "first_byte", "total"} {
		if f[k] == "" {
			t.Errorf("no %s\n%s", k, out)
		}
	}
	// An IP address needs no DNS, and http:// no TLS.
	for _, k := range []string{"dns", "tls", "tls_handshake", "database_error"} {
		if _, ok := f[k]; ok {
			t.Errorf("unexpected %s\n%s", k, out)
		}
	}
	if strings.Contains(out, "\x1b[") {
		t.Error("colored output to a pipe")
	}
}

func TestUnhealthy(t *testing.T) {
	s := server(t, 503, unhealthy)
	code, out, _ := mixer(t, nil, "--server", s.URL, "health")
	if code != exitUnhealthy {
		t.Fatalf("code %d, want %d", code, exitUnhealthy)
	}
	f := fields(out)
	if f["status"] != "unhealthy" || f["database_error"] != "database unavailable" || f["http_status"] != "503" {
		t.Errorf("output:\n%s", out)
	}
}

func TestJSON(t *testing.T) {
	s := server(t, 200, healthy)
	code, out, _ := mixer(t, nil, "health", "--server", s.URL+"/api/v1/", "--json")
	if code != exitOK {
		t.Fatalf("code %d", code)
	}
	var r struct {
		Server     string
		HTTPStatus int `json:"http_status"`
		Health     struct{ Status, Version string }
		Link       struct {
			Protocol string
			Timings  map[string]float64 `json:"timings_ms"`
		}
	}
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if r.Server != s.URL || r.HTTPStatus != 200 || r.Health.Status != "healthy" || r.Health.Version != "v1.2.3" || r.Link.Protocol != "HTTP/1.1" {
		t.Errorf("got %+v", r)
	}
	if _, ok := r.Link.Timings["total"]; !ok {
		t.Errorf("no total in %v", r.Link.Timings)
	}
}

func TestQuietAndEnv(t *testing.T) {
	s := server(t, 503, unhealthy)
	code, out, errb := mixer(t, map[string]string{"SUPERMIXER_URL": s.URL}, "-q", "health")
	if code != exitUnhealthy || out != "" || errb != "" {
		t.Errorf("code %d, stdout %q, stderr %q", code, out, errb)
	}
}

func TestUnreachable(t *testing.T) {
	// A port nothing listens on: take one, then let it go.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()

	code, out, errb := mixer(t, nil, "--server", addr, "health")
	if code != exitUnreachable || out != "" || !strings.Contains(errb, "can't reach http://"+addr) {
		t.Errorf("code %d, stdout %q, stderr %q", code, out, errb)
	}
}

func TestNotSupermixer(t *testing.T) {
	s := httptest.NewServer(http.NotFoundHandler())
	defer s.Close()
	code, _, errb := mixer(t, nil, "--server", s.URL, "health")
	if code != exitUnreachable || !strings.Contains(errb, "didn't answer like a Supermixer (404 Not Found)") {
		t.Errorf("code %d, stderr %q", code, errb)
	}
}

func TestRedirect(t *testing.T) {
	// The address to try instead is the server the redirect points to, not
	// the health check's own address, even when Location is relative.
	for loc, want := range map[string]string{
		"https://example.test/api/v1/health": "redirects to https://example.test/api/v1/health; try --server https://example.test\n",
		"/sm/api/v1/health":                  "/sm/api/v1/health; try --server http://127.0.0.1:",
	} {
		s := httptest.NewServer(http.RedirectHandler(loc, http.StatusMovedPermanently))
		code, _, errb := mixer(t, nil, "--server", s.URL, "health")
		s.Close()
		if code != exitUnreachable || !strings.Contains(errb, want) {
			t.Errorf("Location %s: code %d, stderr %q", loc, code, errb)
		}
	}
}

func TestSlowBody(t *testing.T) {
	// Headers at once, then the body too late: still a timeout.
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}))
	defer s.Close()
	code, _, errb := mixer(t, nil, "--server", s.URL, "--timeout", "200ms", "health")
	if code != exitUnreachable || !strings.Contains(errb, "no answer within 200ms") {
		t.Errorf("code %d, stderr %q", code, errb)
	}
}

func TestUsage(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--server", "http://x"}, "Usage: mixer"}, // no command: the usage, on stderr
		{[]string{"healthz"}, `unknown command "healthz"`},
		{[]string{"help", "healthz"}, `unknown command "healthz"`},
		{[]string{"health"}, "no server"},
		{[]string{"--server", "  ", "health"}, "no server"},
		{[]string{"health", "--server", "ftp://x"}, "http:// or https://"},
		{[]string{"--json", "health", "--server", "http://x", "-q"}, "can't be used together"},
		{[]string{"--server", "http://x", "health", "extra"}, `unexpected argument "extra"`},
		{[]string{"--bogus"}, "flag provided but not defined"},
		{[]string{"health", "--bogus"}, "Try 'mixer help health'"},
		{[]string{"health", "-V"}, "flag provided but not defined: -V"},
	} {
		code, out, errb := mixer(t, nil, tc.args...)
		if code != exitUsage || out != "" || !strings.Contains(errb, tc.want) {
			t.Errorf("%v: code %d, stdout %q, stderr %q", tc.args, code, out, errb)
		}
	}
}

func TestHelpAndVersion(t *testing.T) {
	for args, want := range map[string]string{
		"--help":         "Usage: mixer [options] <command>",
		"help":           "Usage: mixer [options] <command>",
		"help health":    "Usage: mixer [options] health",
		"health --help":  "Usage: mixer [options] health",
		"health -h":      "Usage: mixer [options] health",
		"help --json":    "Usage: mixer [options] <command>",
		"help -q health": "Usage: mixer [options] health",
	} {
		code, out, errb := mixer(t, nil, strings.Fields(args)...)
		if code != exitOK || errb != "" || !strings.HasPrefix(out, want) {
			t.Errorf("mixer %s: code %d, stdout %.40q, stderr %q", args, code, out, errb)
		}
	}
	code, out, _ := mixer(t, nil, "-V")
	if code != exitOK || strings.TrimSpace(out) == "" {
		t.Errorf("-V: code %d, %q", code, out)
	}
}

func TestServerURL(t *testing.T) {
	for in, want := range map[string]string{
		"localhost:8080":                        "http://localhost:8080",
		"https://sm.example.com/":               "https://sm.example.com",
		"https://sm.example.com/api/v1":         "https://sm.example.com",
		"https://sm.example.com/api/v1/health/": "https://sm.example.com",
		"https://sm.example.com/v1":             "https://sm.example.com",
		" sm.example.com:8080 ":                 "http://sm.example.com:8080",
		"https://example.com/supermixer/?x=1#y": "https://example.com/supermixer",
	} {
		u, err := serverURL(in)
		if err != nil || u.String() != want {
			t.Errorf("serverURL(%q) = %v, %v; want %s", in, u, err, want)
		}
	}
}
