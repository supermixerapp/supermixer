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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"supermixer/internal/api"
	"supermixer/internal/config"
	"supermixer/internal/theme"
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
	DB      DB
	Palette *theme.Palette
	Logger  *slog.Logger
	WebUI   fs.FS // built React app; may be empty in development
}

// New builds the root handler.
func New(deps Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(requestLogger(deps.Logger))
	r.Use(middleware.Recoverer)

	h := &handlers{deps: deps}
	strict := api.NewStrictHandlerWithOptions(h, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeError(w, http.StatusBadRequest, err.Error())
		},
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			deps.Logger.ErrorContext(r.Context(), "api handler failed", "path", r.URL.Path, "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
		},
	})

	r.Route("/api/v1", func(r chi.Router) {
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

	r.NotFound(newSPAHandler(deps.WebUI, deps.Config.DefaultTheme).ServeHTTP)
	return r
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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.Error{Message: msg})
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
