package httpapi

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"supermixer/internal/rbac"
)

// gatewayRoute is a part of a stack's API that Supermixer proxies to.
type gatewayRoute struct {
	prefix string // cleaned path, without a leading slash
	exact  bool
	// Methods allowed; GET/HEAD need data read, others data write.
	methods []string
	// auditAs names the audit action for changes, e.g. "project.auth_changed".
	auditAs string
	// read marks a POST that only reads (Storage's file listing): it needs
	// data read, not write, and isn't audited.
	read bool
	// write requires data write for every method, GET included: an Edge
	// Function can do anything, whatever the method.
	write bool
	// websocket allows (and requires) a WebSocket upgrade. Browsers can't
	// send the CSRF header on one, so the token comes as ?csrf= instead.
	websocket bool
}

var gatewayRoutes = []gatewayRoute{
	// Auth admin API: users, invitations.
	{prefix: "auth/v1/admin/users", methods: []string{"GET", "POST", "PUT", "DELETE"}, auditAs: "project.auth_changed"},
	{prefix: "auth/v1/invite", exact: true, methods: []string{"POST"}, auditAs: "project.auth_changed"},
	// Emails a user a password recovery or sign-in link.
	{prefix: "auth/v1/recover", exact: true, methods: []string{"POST"}, auditAs: "project.auth_changed"},
	{prefix: "auth/v1/magiclink", exact: true, methods: []string{"POST"}, auditAs: "project.auth_changed"},
	{prefix: "auth/v1/settings", exact: true, methods: []string{"GET"}},
	// Storage API: buckets and objects. Listing files is a POST that only
	// reads; Storage routes POST object/list/<bucket> to it before uploads.
	{prefix: "storage/v1/object/list", methods: []string{"POST"}, read: true},
	{prefix: "storage/v1/bucket", methods: []string{"GET", "POST", "PUT", "DELETE"}, auditAs: "project.storage_changed"},
	{prefix: "storage/v1/object", methods: []string{"GET", "HEAD", "POST", "PUT", "DELETE"}, auditAs: "project.storage_changed"},
	// PostgREST's OpenAPI description, for the API docs.
	{prefix: "rest/v1", exact: true, methods: []string{"GET"}},
	// Invoking Edge Functions, as the service role.
	{prefix: "functions/v1", methods: []string{"GET", "POST", "PUT", "PATCH", "DELETE"}, write: true, auditAs: "project.function_invoked"},
	// The Realtime Inspector's socket. It can send as well as listen, with
	// the service role, so it needs write access.
	{prefix: "realtime/v1/websocket", exact: true, methods: []string{"GET"}, write: true, websocket: true},
}

// matchGateway finds the route for a cleaned path and method. If a route
// matches the path but not the method, later routes are still tried (a GET of
// object/list/x is a download from a bucket called "list"); it returns that
// route with false when none allows the method, and nil when no path matches.
func matchGateway(p, method string) (*gatewayRoute, bool) {
	var pathOnly *gatewayRoute
	for i := range gatewayRoutes {
		rt := &gatewayRoutes[i]
		if p == rt.prefix || (!rt.exact && strings.HasPrefix(p, rt.prefix+"/")) {
			for _, m := range rt.methods {
				if m == method {
					return rt, true
				}
			}
			if pathOnly == nil {
				pathOnly = rt
			}
		}
	}
	return pathOnly, false
}

// gatewaySegments decodes a proxied path one segment at a time and rejects
// anything that could change which upstream path is reached: dot segments
// (also percent-encoded, %2e%2e), encoded slashes, backslashes, NUL bytes
// and empty segments. A single trailing slash is allowed.
func gatewaySegments(raw string) ([]string, bool) {
	raw = strings.TrimSuffix(raw, "/")
	if raw == "" {
		return nil, false
	}
	parts := strings.Split(raw, "/")
	out := make([]string, len(parts))
	for i, part := range parts {
		seg, err := url.PathUnescape(part)
		if err != nil || seg == "" || seg == "." || seg == ".." || strings.ContainsAny(seg, "/\\\x00") {
			return nil, false
		}
		out[i] = seg
	}
	return out, true
}

// gatewayKey carries the resolved upstream to the proxy's Rewrite.
type gatewayKey struct{}

type gatewayTarget struct {
	url *url.URL
	key string
}

// gateway proxies /api/v1/projects/{ref}/gateway/<path> to the stack's API
// gateway with its admin key. Browsers never see the key.
func (h *handlers) gateway() http.Handler {
	transport := h.network.Transport()
	transport.ResponseHeaderTimeout = h.deps.Config.Projects.GatewayTimeout
	transport.IdleConnTimeout = 90 * time.Second
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			t := pr.In.Context().Value(gatewayKey{}).(gatewayTarget)
			pr.Out.URL = t.url
			pr.Out.Host = t.url.Host
			// Never pass Supermixer's own credentials on.
			for _, k := range []string{"Cookie", "Authorization", "Apikey", "X-Csrf-Token", "Origin", "Referer"} {
				pr.Out.Header.Del(k)
			}
			pr.Out.Header.Set("apikey", t.key)
			pr.Out.Header.Set("Authorization", "Bearer "+t.key)
		},
		ModifyResponse: func(res *http.Response) error {
			// A 401 from the stack means it rejected Supermixer's key, not that
			// the member's Supermixer session ended; the UI signs out on 401.
			if res.StatusCode == http.StatusUnauthorized {
				res.StatusCode = http.StatusBadGateway
				res.Status = "502 Bad Gateway"
				res.Header.Set("X-Supermixer-Upstream-Status", "401")
			}
			res.Header.Del("Set-Cookie")
			res.Header.Del("Access-Control-Allow-Origin")
			// Files come from users; keep any HTML or SVG away from our origin.
			res.Header.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
			res.Header.Set("X-Content-Type-Options", "nosniff")
			return nil
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				return
			}
			h.deps.Logger.WarnContext(r.Context(), "gateway request failed", "path", r.URL.Path, "err", err)
			writeError(w, http.StatusBadGateway, "could not reach the project's API gateway")
		},
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ref := chi.URLParam(r, "ref")
		raw := chi.URLParam(r, "*")
		segments, ok := gatewaySegments(raw)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid path")
			return
		}
		clean := strings.Join(segments, "/")
		rt, methodOK := matchGateway(clean, r.Method)
		if rt == nil {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		if !methodOK {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		if upgrade != rt.websocket {
			writeError(w, http.StatusBadRequest, "this path needs a WebSocket upgrade, and only it")
			return
		}
		perm, action := rbac.ProjectDataRead, "view this project's data"
		if rt.write || (r.Method != http.MethodGet && r.Method != http.MethodHead && !rt.read) {
			perm, action = rbac.ProjectDataWrite, "change this project's data"
		}
		query := r.URL.Query()
		// The session middleware checks CSRF on unsafe methods only. A write
		// route acts even on GET (an Edge Function call), and SameSite=Lax
		// cookies ride along on another site's top-level GET, so check here.
		// Access tokens aren't sent by browsers on their own: no CSRF.
		viaToken := reqInfo(r.Context()).Principal != nil && reqInfo(r.Context()).Principal.AccessToken != nil
		if rt.write && !rt.websocket && safeMethod(r.Method) && !viaToken {
			info := reqInfo(r.Context())
			if info.Principal == nil || !h.csrf.Valid(info.Principal.Token, r.Header.Get(csrfHeader)) {
				writeError(w, http.StatusForbidden, "missing or invalid CSRF token; reload the page and try again")
				return
			}
		}
		if rt.websocket && !viaToken {
			// Double-submit, like the X-CSRF-Token header: another site can
			// open a socket with our cookies but can't read sm_csrf.
			info := reqInfo(r.Context())
			if info.Principal == nil || !h.csrf.Valid(info.Principal.Token, query.Get("csrf")) {
				writeError(w, http.StatusForbidden, "missing or invalid CSRF token; reload the page and try again")
				return
			}
			query.Del("csrf")
		}
		ctx := r.Context()
		a, err := h.loadProject(ctx, ref, perm, action)
		if err == nil {
			c, cerr := h.connection(a.Project())
			if cerr != nil {
				err = cerr
			} else {
				base, perr := url.Parse(c.APIURL)
				if perr != nil {
					err = perr
				} else {
					if base.Path == "" {
						base.Path = "/" // JoinPath drops the leading slash otherwise
					}
					// Segments are decoded and checked; escape each again so
					// nothing in a name can change the path upstream.
					escaped := make([]string, len(segments))
					for i, seg := range segments {
						escaped[i] = url.PathEscape(seg)
					}
					u := base.JoinPath(escaped...)
					if strings.HasSuffix(raw, "/") {
						u = u.JoinPath("/") // PostgREST's root needs it
					}
					u.RawQuery = r.URL.RawQuery
					if rt.websocket {
						u.RawQuery = query.Encode()
					}
					ctx = context.WithValue(ctx, gatewayKey{}, gatewayTarget{url: u, key: c.Keys.Admin()})
				}
			}
		}
		if err != nil {
			status, code, msg, _ := errorStatus(err)
			writeErrorCode(w, status, code, msg)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<30)

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		proxy.ServeHTTP(rec, r.WithContext(ctx))

		if rt.auditAs != "" && perm == rbac.ProjectDataWrite && rec.status < 400 {
			p := a.Project()
			// The client may have gone; the change still happened.
			h.audit(context.WithoutCancel(ctx), h.deps.Store.Queries, auditEntry{
				OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: rt.auditAs,
				TargetType: "project", TargetID: p.Ref, TargetName: p.Name,
				Metadata: map[string]any{"method": r.Method, "path": clean},
			})
		}
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Hijack lets WebSocket upgrades through.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("the connection can't be taken over")
	}
	s.status = http.StatusSwitchingProtocols
	return hj.Hijack()
}

// Flush keeps streaming responses streaming.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
