package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const healthPath = "/api/v1/health"

// hstsRecheck is how often HSTS's gate looks again for plain-HTTP projects.
const hstsRecheck = time.Minute

// RedirectToHTTPS is the plain-HTTP listener's handler when Supermixer
// serves HTTPS itself: everything goes to public_url, except health checks,
// which probes make over plain HTTP.
func RedirectToHTTPS(publicURL string, app http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == healthPath {
			app.ServeHTTP(w, r)
			return
		}
		redirectToPublic(w, r, publicURL)
	})
}

// redirectToPublic sends r to the same path on public_url's origin: never
// a host from the request, which the client controls.
func redirectToPublic(w http.ResponseWriter, r *http.Request, publicURL string) {
	u, err := url.Parse(publicURL)
	if err != nil {
		http.Error(w, "bad public_url", http.StatusInternalServerError)
		return
	}
	target := u.Scheme + "://" + u.Host + r.URL.RequestURI()
	w.Header().Set("Location", target)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusPermanentRedirect) // keeps the method and body
}

// forwardedProto is the scheme a proxy says the client used.
func forwardedProto(r *http.Request) string {
	p, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	return strings.ToLower(strings.TrimSpace(p))
}

// secureRequest reports whether the client reached Supermixer over HTTPS:
// directly, or through a trusted proxy that says so.
func (h *handlers) secureRequest(r *http.Request) bool {
	return r.TLS != nil || (h.deps.Config.Server.TrustProxy && forwardedProto(r) == "https")
}

// transportSecurity keeps browsers on HTTPS when public_url is https://:
// a trusted proxy's plain-HTTP requests are redirected, and secure ones get
// HSTS.
func (h *handlers) transportSecurity(next http.Handler) http.Handler {
	srv := h.deps.Config.Server
	pu, err := url.Parse(srv.PublicURL)
	if err != nil || pu.Scheme != "https" {
		return next
	}
	hsts := h.hstsHeader()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if srv.TrustProxy && forwardedProto(r) == "http" && r.URL.Path != healthPath {
			redirectToPublic(w, r, srv.PublicURL)
			return
		}
		if hsts != "" && h.secureRequest(r) && h.hsts.safe(h, pu.Hostname()) {
			w.Header().Set("Strict-Transport-Security", hsts)
		}
		next.ServeHTTP(w, r)
	})
}

// hstsHeader is the Strict-Transport-Security header for secure requests,
// or "" for none: HSTS off, public_url not https://, or a host name HSTS
// can't apply to.
func (h *handlers) hstsHeader() string {
	srv := h.deps.Config.Server
	pu, err := url.Parse(srv.PublicURL)
	if err != nil || pu.Scheme != "https" || srv.HSTSMaxAge <= 0 || !namedHost(pu.Hostname()) {
		return ""
	}
	// No includeSubDomains: other services may live under the same domain
	// on plain HTTP.
	return "max-age=" + strconv.FormatInt(int64(srv.HSTSMaxAge/time.Second), 10)
}

// namedHost reports whether HSTS can apply to host: browsers ignore it for
// IP addresses, and localhost is shared by everything on a developer's
// machine.
func namedHost(host string) bool {
	host = strings.ToLower(host)
	return net.ParseIP(host) == nil && host != "localhost" && !strings.HasSuffix(host, ".localhost")
}

// hstsGate decides whether HSTS is safe to send. Browsers apply it to every
// port of the host, so while any project on Supermixer's host name is still
// reached over plain HTTP (a stack Supermixer created without TLS, say),
// HSTS would cut browsers off from it.
type hstsGate struct {
	mu      sync.Mutex
	checked time.Time // when ok was last worked out (or tried)
	ok      bool      // false until the first check: no HSTS while unsure
	running bool      // a check is under way
}

// safe answers at once, from the last check, and starts a new check in the
// background once that's a minute old: requests never wait on the
// database. Without a database (tests) it's always safe.
func (g *hstsGate) safe(h *handlers, host string) bool {
	if h.deps.Store == nil {
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if time.Since(g.checked) >= hstsRecheck && !g.running {
		g.running = true
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			g.check(ctx, h, host)
		}()
	}
	return g.ok
}

// check works out whether HSTS is safe now. A failed query keeps the last
// answer, and isn't tried again for a minute.
func (g *hstsGate) check(ctx context.Context, h *handlers, host string) bool {
	if h.deps.Store == nil {
		return true
	}
	rows, err := h.deps.Store.Queries.ListPlainHTTPURLs(ctx)
	g.mu.Lock()
	defer g.mu.Unlock()
	g.running, g.checked = false, time.Now()
	if err != nil {
		return g.ok
	}
	var urls []string
	for _, row := range rows {
		urls = append(urls, row.ApiUrl, row.StudioUrl)
	}
	ok := !plainOnHost(urls, host)
	if !ok && g.ok {
		h.deps.Logger.Info("not sending HSTS: a project on " + host + " is now reached over plain HTTP")
	}
	g.ok = ok
	return ok
}

// forget stops HSTS until the next check, which the next request starts
// (after a stack's addresses change).
func (g *hstsGate) forget() {
	g.mu.Lock()
	g.ok, g.checked = false, time.Time{}
	g.mu.Unlock()
}

// plainOnHost reports whether any of urls is plain HTTP on host.
func plainOnHost(urls []string, host string) bool {
	for _, raw := range urls {
		if u, err := url.Parse(raw); err == nil && u.Scheme == "http" && strings.EqualFold(u.Hostname(), host) {
			return true
		}
	}
	return false
}
