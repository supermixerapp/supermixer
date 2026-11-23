package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/theme"
)

type fakeDB struct{ err error }

func (f fakeDB) Ping(context.Context) error                     { return f.err }
func (f fakeDB) SchemaVersion(context.Context) (int64, error)   { return 1, f.err }
func (f fakeDB) InstalledAt(context.Context) (time.Time, error) { return time.Unix(0, 0).UTC(), f.err }

func newTestServer(t *testing.T, db DB, web fstest.MapFS) http.Handler {
	t.Helper()
	p, err := theme.Derive("#0019A8")
	if err != nil {
		t.Fatal(err)
	}
	var webFS = web
	return New(Deps{
		Config:  &config.Config{DefaultTheme: "light"},
		DB:      db,
		Palette: p,
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		WebUI:   webFS,
	})
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

var builtUI = fstest.MapFS{
	"index.html":         {Data: []byte(`<meta name="sm-default-theme" content="%SM_DEFAULT_THEME%">app`)},
	"assets/app-abc.js":  {Data: []byte("console.log(1)")},
	"assets/app-abc.css": {Data: []byte("body{}")},
}

func TestHealthy(t *testing.T) {
	rec := get(t, newTestServer(t, fakeDB{}, builtUI), "/api/v1/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["status"] != "healthy" {
		t.Errorf("body = %v", body)
	}
}

func TestUnhealthyHidesErrorDetail(t *testing.T) {
	rec := get(t, newTestServer(t, fakeDB{err: errors.New("dial tcp 10.0.0.5:5432: refused")}, builtUI), "/api/v1/health")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "10.0.0.5") {
		t.Errorf("health response leaks internal error: %s", rec.Body)
	}
}

func TestUiConfig(t *testing.T) {
	rec := get(t, newTestServer(t, fakeDB{}, builtUI), "/api/v1/ui-config")
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["brand_color"] != "#0019a8" || body["default_theme"] != "light" || body["app_name"] != "Supermixer" {
		t.Errorf("body = %v", body)
	}
}

func TestUnknownAPIRouteIsJSON404(t *testing.T) {
	rec := get(t, newTestServer(t, fakeDB{}, builtUI), "/api/v1/nope")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Header().Get("Content-Type"), "json") {
		t.Fatalf("got %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestThemeCSSAndFavicon(t *testing.T) {
	h := newTestServer(t, fakeDB{}, builtUI)
	rec := get(t, h, "/theme.css")
	if !strings.Contains(rec.Body.String(), "--sm-brand: #0019a8;") || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/css") {
		t.Fatalf("theme.css: %s", rec.Body)
	}
	etag := rec.Header().Get("ETag")
	req := httptest.NewRequest(http.MethodGet, "/theme.css", nil)
	req.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusNotModified {
		t.Errorf("conditional GET = %d, want 304", rec2.Code)
	}
	for _, inm := range []string{"W/" + etag, `"other", ` + etag, "*"} {
		req := httptest.NewRequest(http.MethodGet, "/theme.css", nil)
		req.Header.Set("If-None-Match", inm)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotModified {
			t.Errorf("If-None-Match %q = %d, want 304", inm, rec.Code)
		}
	}
	head := httptest.NewRecorder()
	h.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/theme.css", nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" {
		t.Errorf("HEAD /theme.css = %d, body %d bytes", head.Code, head.Body.Len())
	}
	if fav := get(t, h, "/favicon.svg"); fav.Header().Get("Content-Type") != "image/svg+xml" {
		t.Errorf("favicon content type %q", fav.Header().Get("Content-Type"))
	}
}

func TestSPA(t *testing.T) {
	h := newTestServer(t, fakeDB{}, builtUI)

	rec := get(t, h, "/project/abc/editor")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `content="light"`) {
		t.Fatalf("client route: %d %s", rec.Code, rec.Body)
	}
	asset := get(t, h, "/assets/app-abc.js")
	if asset.Code != http.StatusOK || !strings.Contains(asset.Header().Get("Cache-Control"), "immutable") {
		t.Errorf("asset: %d %q", asset.Code, asset.Header().Get("Cache-Control"))
	}
	if missing := get(t, h, "/assets/missing.js"); missing.Code != http.StatusNotFound {
		t.Errorf("missing asset = %d, want 404", missing.Code)
	}
	if dotted := get(t, h, "/org/acme.io"); dotted.Code != http.StatusOK || !strings.Contains(dotted.Body.String(), "app") {
		t.Errorf("dotted client route = %d, want index.html", dotted.Code)
	}
}

func TestSPANotBuilt(t *testing.T) {
	rec := get(t, newTestServer(t, fakeDB{}, fstest.MapFS{}), "/")
	if !strings.Contains(rec.Body.String(), "web UI has not been built") {
		t.Errorf("body = %s", rec.Body)
	}
}
