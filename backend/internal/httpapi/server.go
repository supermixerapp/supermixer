// Package httpapi wires the HTTP surface: the generated REST API under
// /api/v1, the generated theme assets, and the embedded single-page app.
package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/config"
	"supermixer/internal/mail"
	"supermixer/internal/metrics"
	"supermixer/internal/provision"
	"supermixer/internal/secrets"
	"supermixer/internal/stack"
	"supermixer/internal/store"
	"supermixer/internal/theme"
	"supermixer/internal/tlscert"
)

// DB is what the HTTP layer needs from the store.
type DB interface {
	Ping(ctx context.Context) error
	SchemaVersion(ctx context.Context) (int64, error)
	InstalledAt(ctx context.Context) (time.Time, error)
}

// Deps are the server's collaborators.
type Deps struct {
	Config  *config.Config
	DB      DB           // health checks
	Store   *store.Store // everything else
	Box     *secrets.Box
	Palette *theme.Palette
	Logger  *slog.Logger
	WebUI   fs.FS // built React app; may be empty in development
	Pools   *stack.Pools
	// BackupStore replaces the bucket provisioning.backup_s3 describes (tests).
	BackupStore provision.ObjectStore
	// Mailer replaces the SMTP server email describes (tests).
	Mailer mail.Sender
	// Pending counts work to finish before exiting, such as emails being
	// sent in the background; the caller waits for it after shutting down.
	Pending *sync.WaitGroup
	// Metrics records Prometheus metrics; nil records nothing.
	Metrics *metrics.Metrics
	// TLS is the certificate ([tls]); nil while TLS is off.
	TLS *tlscert.Manager
	// LeaderRetry is how often an instance that isn't doing the background
	// work checks whether it should (10s if zero).
	LeaderRetry time.Duration
	// Background, if set, runs periodic work (recovering stuck stack
	// operations) until it's cancelled.
	Background context.Context
	// PortFree reports whether nothing on this machine listens on a port,
	// for picking a new stack's ports; provision.ListenFree if nil. Tests
	// replace it so they don't depend on what runs on the machine.
	PortFree func(port int) bool
}

// New builds the root handler.
func New(deps Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	if deps.Config.Server.TrustProxy {
		// Only behind a reverse proxy: otherwise clients could spoof their IP.
		r.Use(middleware.RealIP)
	}
	r.Use(requestLogger(deps.Logger))
	r.Use(requestMetrics(deps.Metrics))
	r.Use(middleware.Recoverer)

	pc := deps.Config.Projects
	network := StackNetwork(deps.Config, deps.TLS)
	if deps.Pools == nil {
		deps.Pools = stack.NewPools(pc.DBPoolSize, network)
	}
	signIn := deps.Config.Security.SignIn
	h := &handlers{
		deps:    deps,
		csrf:    auth.NewCSRF([]byte(deps.Config.Security.EncryptionKey)),
		limiter: auth.NewLimiter(signIn.MaxFailures, signIn.Lockout),
		checker: stack.NewChecker(pc.HealthCheckTimeout, network),
		network: network,
		health:  &healthCache{ttl: pc.HealthCacheTTL},
		pools:   deps.Pools,
		stacks:  &stackJobs{},
		uploads: newUploader(),
		// Emails people can ask Supermixer to send to others.
		inviteMail:  auth.NewLimiter(30, time.Hour), // per inviter
		resetMail:   auth.NewLimiter(5, time.Hour),  // per account
		signUpIP:    auth.NewLimiter(10, time.Hour), // per client address
		signUpMail:  auth.NewLimiter(3, time.Hour),  // per email address
		pending:     deps.Pending,
		sso:         newSSOProviders(deps.Config.SSO),
		webhookHTTP: webhookClient(deps.Config.Webhooks.AllowPrivateAddresses),
	}
	if h.pending == nil {
		h.pending = &sync.WaitGroup{}
	}
	r.Use(h.transportSecurity)
	h.certChanged = make(chan struct{}, 1)
	deps.TLS.OnChange(func() {
		select {
		case h.certChanged <- struct{}{}:
		default:
		}
	})
	if pv := deps.Config.Provisioning; deps.BackupStore != nil {
		h.s3 = deps.BackupStore
	} else if pv.Enabled && pv.BackupS3.Enabled() {
		s3, err := provision.NewS3(pv.BackupS3)
		if err != nil {
			deps.Logger.Error("backups won't be copied to S3", "err", err)
		} else {
			h.s3 = s3
		}
	}
	if deps.Mailer != nil {
		h.mailer = deps.Mailer
	} else if m, err := mail.New(deps.Config.Email); err != nil {
		deps.Logger.Error("email is off", "err", err)
	} else if m != nil {
		h.mailer = m
	}
	if deps.Store != nil {
		if deps.Background != nil {
			// With several replicas, one does the background work.
			retry := deps.LeaderRetry
			if retry == 0 {
				retry = 10 * time.Second
			}
			go deps.Store.RunAsLeader(deps.Background, deps.Logger, retry, h.backgroundWork)
		} else {
			h.syncManagedRows(context.Background())
			h.recoverStacks(context.Background(), time.Now().Add(-stackStale))
		}
	}
	strict := api.NewStrictHandlerWithOptions(h, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeError(w, http.StatusBadRequest, err.Error())
		},
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			status, code, msg, expected := errorStatus(err)
			if !expected {
				deps.Logger.ErrorContext(r.Context(), "api handler failed", "path", r.URL.Path, "err", err)
			}
			writeErrorCode(w, status, code, msg)
		},
	})

	// The Supabase-style Management API (a subset), for access tokens.
	r.Mount("/v1", h.managementAPI())

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(h.sessionMiddleware)
		r.Handle("/projects/{ref}/gateway/*", h.gateway())
		// Single sign-on: redirects, so outside the JSON API's handlers.
		r.Get("/auth/sso/{provider}/start", h.ssoStart)
		r.Get("/auth/sso/{provider}/callback", h.ssoCallback)
		r.Post("/profile/identities/{provider}/connect", h.ssoConnect)
		// The private CA ([tls] ca_file), for clients to trust; public.
		r.Get("/tls/ca.pem", h.caCertificate)
		// This API's OpenAPI description, for docs and client generators.
		r.Get("/openapi.json", func(w http.ResponseWriter, _ *http.Request) {
			spec, err := api.GetSwagger()
			if err != nil {
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			spec.Servers = nil
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(spec)
		})
		api.HandlerFromMux(strict, r)
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusNotFound, "not found")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		})
	})

	css := []byte(deps.Palette.CSS())
	favicon := []byte(deps.Palette.FaviconSVG())
	for path, h := range map[string]http.HandlerFunc{
		"/theme.css":   staticBytes("text/css; charset=utf-8", css),
		"/favicon.svg": staticBytes("image/svg+xml", favicon),
	} {
		r.Get(path, h)
		r.Head(path, h)
	}

	r.NotFound(newSPAHandler(deps.WebUI, deps.Config.Appearance.DefaultTheme, deps.Config.Server.DevWebURL).ServeHTTP)
	return r
}

// StackNetwork is how Supermixer reaches projects' stacks: the ones it
// created at connect_host when that's set (their rows say public_host, as
// users see them), trusting [tls]'s CA and its own certificate.
func StackNetwork(cfg *config.Config, certs *tlscert.Manager) *stack.Network {
	aliases := map[string]string{}
	if pv := cfg.Provisioning; pv.Enabled && pv.ConnectHost != "" {
		aliases[pv.PublicHost] = pv.ConnectHost
	}
	if certs == nil {
		return stack.NewNetwork(aliases, nil, nil)
	}
	return stack.NewNetwork(aliases, certs.RootCAs(), certs.Issued)
}

// staticBytes serves generated content with an ETag so browsers revalidate
// cheaply; the content only changes when Supermixer restarts.
func staticBytes(contentType string, body []byte) http.HandlerFunc {
	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:8]) + `"`
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("ETag", etag)
		if etagMatches(r.Header.Get("If-None-Match"), etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(body)
	}
}

// etagMatches implements If-None-Match's weak comparison (RFC 9110 §13.1.2):
// a comma-separated list, "*", and W/ prefixes all count.
func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeErrorCode(w, status, "", msg)
}

// writeErrorCode writes an error with a code clients can act on.
func writeErrorCode(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	e := api.Error{Message: msg}
	if code != "" {
		e.Code = &code
	}
	_ = json.NewEncoder(w).Encode(e)
}

func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			logger.LogAttrs(r.Context(), slog.LevelDebug, "http request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", ww.Status()),
				slog.Duration("duration", time.Since(start)),
				slog.String("request_id", middleware.GetReqID(r.Context())),
			)
		})
	}
}

// backgroundWork is what the leader instance runs, until ctx ends.
func (h *handlers) backgroundWork(ctx context.Context) {
	var wg sync.WaitGroup
	run := func(f func(context.Context)) {
		wg.Add(1)
		go func() { defer wg.Done(); f(ctx) }()
	}
	h.syncManagedRows(ctx) // before anything uses the addresses
	run(h.watchStacks)
	run(h.applyStudio)
	run(h.applyTLS)
	run(h.backupLoop)
	if h.s3 != nil {
		run(h.uploadLoop)
	}
	run(h.drainLoop)
	run(h.webhookLoop)
	wg.Wait()
}

// requestMetrics counts requests by their route pattern.
func requestMetrics(m *metrics.Metrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if m == nil {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			next.ServeHTTP(ww, r)
			route := ""
			if rc := chi.RouteContext(r.Context()); rc != nil {
				route = rc.RoutePattern()
			}
			if route == "" || route == "/*" {
				route = "static" // the web app and its files
			}
			m.Request(r.Method, route, ww.Status(), time.Since(start))
		})
	}
}
