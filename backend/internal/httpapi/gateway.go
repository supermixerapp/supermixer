package httpapi

import (
	"context"
	"errors"
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
}

var gatewayRoutes = []gatewayRoute{
	// Auth admin API: users, invitations.
	{prefix: "auth/v1/admin/users", methods: []string{"GET", "POST", "PUT", "DELETE"}, auditAs: "project.auth_changed"},
	{prefix: "auth/v1/invite", exact: true, methods: []string{"POST"}, auditAs: "project.auth_changed"},
	{prefix: "auth/v1/settings", exact: true, methods: []string{"GET"}},
	// Storage API: buckets and objects.
	{prefix: "storage/v1/bucket", methods: []string{"GET", "POST", "PUT", "DELETE"}, auditAs: "project.storage_changed"},
	{prefix: "storage/v1/object", methods: []string{"GET", "HEAD", "POST", "PUT", "DELETE"}, auditAs: "project.storage_changed"},
	// PostgREST's OpenAPI description, for the API docs.
	{prefix: "rest/v1", exact: true, methods: []string{"GET"}},
}

// matchGateway finds the route for a cleaned path, or nil.
func matchGateway(p, method string) (*gatewayRoute, bool) {
	for i := range gatewayRoutes {
		rt := &gatewayRoutes[i]
		if p == rt.prefix || (!rt.exact && strings.HasPrefix(p, rt.prefix+"/")) {
			for _, m := range rt.methods {
				if m == method {
					return rt, true
				}
			}
			return rt, false
		}
	}
	return nil, false
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
			res.Header.Del("Set-Cookie")
			res.Header.Del("Access-Control-Allow-Origin")
			// Files come from users; keep any HTML or SVG away from our origin.
			res.Header.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
			res.Header.Set("X-Content-Type-Options", "nosniff")
			return nil
		},
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: h.deps.Config.Projects.GatewayTimeout,
			IdleConnTimeout:       90 * time.Second,
		},
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
		perm, action := rbac.ProjectDataRead, "view this project's data"
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			perm, action = rbac.ProjectDataWrite, "change this project's data"
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
					ctx = context.WithValue(ctx, gatewayKey{}, gatewayTarget{url: u, key: c.Keys.Admin()})
				}
			}
		}
		if err != nil {
			status, msg, _ := errorStatus(err)
			writeError(w, status, msg)
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

// Flush keeps streaming responses streaming.
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
