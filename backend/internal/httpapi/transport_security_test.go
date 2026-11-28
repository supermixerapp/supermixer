package httpapi

import (
	"crypto/tls"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/theme"
)

func serverWith(t *testing.T, configure func(*config.Config)) http.Handler {
	t.Helper()
	cfg := lightConfig()
	configure(cfg)
	p, _ := theme.Derive("#0019A8")
	return New(Deps{Config: cfg, DB: fakeDB{}, Palette: p, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), WebUI: builtUI})
}

func TestRedirectToHTTPS(t *testing.T) {
	app := serverWith(t, func(c *config.Config) { c.Server.PublicURL = "https://sm.example.com/" })
	h := RedirectToHTTPS("https://sm.example.com/", app)

	// The client's Host header never picks where it goes.
	req := httptest.NewRequest(http.MethodPost, "http://evil.example/api/v1/projects?x=1", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusPermanentRedirect || rec.Header().Get("Location") != "https://sm.example.com/api/v1/projects?x=1" {
		t.Errorf("redirect: %d %q", rec.Code, rec.Header().Get("Location"))
	}
	// Health checks are answered over plain HTTP, for probes.
	if rec := get(t, h, "/api/v1/health"); rec.Code != http.StatusOK {
		t.Errorf("health: %d", rec.Code)
	}
}

func TestTransportSecurity(t *testing.T) {
	const year = "max-age=31536000"
	type req struct {
		proto  string // X-Forwarded-Proto
		tls    bool
		path   string
		status int
		hsts   string
	}
	for _, tc := range []struct {
		name      string
		configure func(*config.Config)
		reqs      []req
	}{
		{"behind a proxy", func(c *config.Config) {
			c.Server.PublicURL, c.Server.TrustProxy = "https://sm.example.com", true
		}, []req{
			{proto: "http", path: "/projects", status: http.StatusPermanentRedirect},
			{proto: "http", path: "/api/v1/health", status: http.StatusOK},
			{proto: "https", path: "/projects", status: http.StatusOK, hsts: year},
			{proto: "https, http", path: "/projects", status: http.StatusOK, hsts: year},
			{path: "/projects", status: http.StatusOK}, // a probe, straight to the pod
		}},
		{"serving HTTPS itself", func(c *config.Config) {
			c.Server.PublicURL, c.Server.HSTSMaxAge = "https://sm.example.com", time.Hour
		}, []req{
			{tls: true, path: "/projects", status: http.StatusOK, hsts: "max-age=3600"},
			// An untrusted proxy header changes nothing.
			{proto: "https", path: "/projects", status: http.StatusOK},
			{proto: "http", path: "/projects", status: http.StatusOK},
		}},
		{"HSTS off", func(c *config.Config) {
			c.Server.PublicURL, c.Server.HSTSMaxAge = "https://sm.example.com", 0
		}, []req{{tls: true, path: "/projects", status: http.StatusOK}}},
		{"no HSTS for localhost", func(c *config.Config) {
			c.Server.PublicURL = "https://localhost:8443"
		}, []req{{tls: true, path: "/projects", status: http.StatusOK}}},
		{"no HSTS for an IP address", func(c *config.Config) {
			c.Server.PublicURL = "https://192.0.2.1"
		}, []req{{tls: true, path: "/projects", status: http.StatusOK}}},
		{"plain public_url", func(c *config.Config) {
			c.Server.PublicURL, c.Server.TrustProxy = "http://sm.example.com", true
		}, []req{{proto: "http", path: "/projects", status: http.StatusOK}, {tls: true, path: "/projects", status: http.StatusOK}}},
	} {
		h := serverWith(t, tc.configure)
		for _, r := range tc.reqs {
			hr := httptest.NewRequest(http.MethodGet, r.path, nil)
			if r.proto != "" {
				hr.Header.Set("X-Forwarded-Proto", r.proto)
			}
			if r.tls {
				hr.TLS = &tls.ConnectionState{}
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, hr)
			if rec.Code != r.status || rec.Header().Get("Strict-Transport-Security") != r.hsts {
				t.Errorf("%s: %+v: got %d, HSTS %q", tc.name, r, rec.Code, rec.Header().Get("Strict-Transport-Security"))
			}
			if r.status == http.StatusPermanentRedirect && rec.Header().Get("Location") != "https://sm.example.com"+r.path {
				t.Errorf("%s: Location %q", tc.name, rec.Header().Get("Location"))
			}
		}
	}
}

func TestPlainOnHost(t *testing.T) {
	for _, tc := range []struct {
		urls []string
		want bool
	}{
		{[]string{"http://sm.example.com:8201"}, true},
		{[]string{"https://sm.example.com:8201", "http://SM.example.com:3000"}, true},
		{[]string{"https://sm.example.com:8201", ""}, false},
		{[]string{"http://other.example.com:8201", "http://sm.example.com.evil:1"}, false},
	} {
		if got := plainOnHost(tc.urls, "sm.example.com"); got != tc.want {
			t.Errorf("%v: %v", tc.urls, got)
		}
	}
}

func TestCookiesAreSecureOverHTTPS(t *testing.T) {
	for url, secure := range map[string]bool{"https://sm.example.com": true, "http://localhost:8080": false} {
		cfg := lightConfig()
		cfg.Server.PublicURL = url
		h := &handlers{deps: Deps{Config: cfg}}
		cookies := append(h.clearedCookies(), h.cookie(&http.Cookie{Name: mfaCookie, SameSite: http.SameSiteStrictMode}))
		for _, c := range cookies {
			if c.Secure != secure || c.SameSite == 0 {
				t.Errorf("%s: %s Secure %v SameSite %v", url, c.Name, c.Secure, c.SameSite)
			}
		}
		if cookies[len(cookies)-1].SameSite != http.SameSiteStrictMode {
			t.Error("cookie's own SameSite overridden")
		}
	}
}
