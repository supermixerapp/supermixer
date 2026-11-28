package stack

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestURI(t *testing.T) {
	d := Database{Host: "localhost", Port: 54322, Name: "postgres", User: "postgres.dev", Password: "p@ss/word", SSLMode: "disable"}
	if got := d.URI(true); got != "postgresql://postgres.dev:p%40ss%2Fword@localhost:54322/postgres?sslmode=disable" {
		t.Errorf("URI(true) = %s", got)
	}
	if got := d.URI(false); got != "postgresql://postgres.dev:[YOUR-PASSWORD]@localhost:54322/postgres?sslmode=disable" {
		t.Errorf("URI(false) = %s", got)
	}
}

func TestNormalizeAPIURL(t *testing.T) {
	if got, err := NormalizeAPIURL(" http://localhost:8000/ "); err != nil || got != "http://localhost:8000" {
		t.Errorf("got %q %v", got, err)
	}
	for _, bad := range []string{"localhost:8000", "ftp://x", ""} {
		if _, err := NormalizeAPIURL(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestKeys(t *testing.T) {
	k := Keys{Anon: "a.b.c", Secret: "sb_secret_x"}
	if k.Public() != "a.b.c" || k.Admin() != "sb_secret_x" || k.Validate() != nil {
		t.Fatalf("unexpected %+v", k)
	}
	if (Keys{Anon: "x"}).Validate() == nil {
		t.Fatal("missing admin key accepted")
	}
}

// A fake gateway: auth and storage healthy, pg-meta rejects the key, REST 404.
func TestCheckReportsEachService(t *testing.T) {
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/v1/health":
			if r.Header.Get("apikey") != "anon.k.ey" {
				t.Errorf("auth got apikey %q", r.Header.Get("apikey"))
			}
			_, _ = w.Write([]byte(`{"version":"v2.180.0"}`))
		case "/storage/v1/status":
			w.WriteHeader(200)
		case "/pg/config/version":
			w.WriteHeader(401)
		default:
			w.WriteHeader(404)
		}
	}))
	defer gw.Close()

	c := NewChecker(2*time.Second, nil)
	r := c.Check(context.Background(), Connection{
		APIURL:   gw.URL,
		Keys:     Keys{Anon: "anon.k.ey", ServiceRole: "service.k.ey"},
		Database: Database{Host: "127.0.0.1", Port: 1, Name: "postgres", User: "u", SSLMode: "disable"},
	})
	byName := map[string]ServiceCheck{}
	for _, s := range r.Services {
		byName[s.Service] = s
	}
	if byName["auth"].Status != StatusOK || r.AuthVersion != "v2.180.0" {
		t.Errorf("auth: %+v version %q", byName["auth"], r.AuthVersion)
	}
	if byName["storage"].Status != StatusOK {
		t.Errorf("storage: %+v", byName["storage"])
	}
	if !strings.Contains(byName["meta"].Detail, "rejected the API key") {
		t.Errorf("meta: %+v", byName["meta"])
	}
	if !strings.Contains(byName["rest"].Detail, "404") {
		t.Errorf("rest: %+v", byName["rest"])
	}
	if byName["database"].Status != StatusError {
		t.Errorf("database should fail on port 1: %+v", byName["database"])
	}
	if r.Status != Unhealthy {
		t.Errorf("status = %s, want unhealthy (database down)", r.Status)
	}
}
