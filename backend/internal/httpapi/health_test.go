package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"supermixer/internal/config"
)

// A page that navigates away mid-check cancels its request; the half-done
// report mustn't be cached and shown to the next caller as degraded.
func TestHealthCheckOutlivesItsRequest(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rest/v1/" {
			time.Sleep(300 * time.Millisecond)
		}
		if r.URL.Path == "/auth/v1/health" {
			_, _ = w.Write([]byte(`{"version":"v2.test"}`))
			return
		}
		w.WriteHeader(200)
	}))
	t.Cleanup(slow.Close)
	env := newTestEnvWith(t, func(c *config.Config) { c.Projects.HealthCacheTTL = time.Second })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Health"}, nil)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/health/projects", map[string]any{"name": "H", "connection": connectionFor(t, slow.URL, env.dbURL)}, &p)

	// Registering checked it; let that report expire, then give up early.
	time.Sleep(1100 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", env.server.URL+"/api/v1/projects/"+p.Ref+"/health", nil)
	if resp, err := admin.http.Do(req); err == nil {
		resp.Body.Close()
	}
	time.Sleep(400 * time.Millisecond) // the abandoned check finishes

	var h struct{ Status string }
	admin.must(200, "GET", "/projects/"+p.Ref+"/health", nil, &h)
	if h.Status != "healthy" {
		t.Fatalf("after an abandoned check: %s", h.Status)
	}
}
