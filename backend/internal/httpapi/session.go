package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/auth"
	"supermixer/internal/store/db"
)

const (
	sessionCookie = "sm_session"
	csrfCookie    = "sm_csrf"
	csrfHeader    = "X-CSRF-Token"
)

// principal is the signed-in user for a request.
type principal struct {
	User    db.User
	Session db.Session
	Token   string
}

// requestInfo carries what handlers need from the HTTP request, since
// strict handlers only see a context.
type requestInfo struct {
	IP        string
	UserAgent string
	Principal *principal
}

type ctxKey struct{}

func withRequestInfo(ctx context.Context, info *requestInfo) context.Context {
	return context.WithValue(ctx, ctxKey{}, info)
}

func reqInfo(ctx context.Context) *requestInfo {
	if info, ok := ctx.Value(ctxKey{}).(*requestInfo); ok {
		return info
	}
	return &requestInfo{}
}

// currentUser returns the signed-in user. The session middleware rejects
// unauthenticated requests to non-public routes, so this only fails if a
// public route calls it.
func currentUser(ctx context.Context) (*principal, error) {
	if p := reqInfo(ctx).Principal; p != nil {
		return p, nil
	}
	return nil, errUnauthorized
}

// publicRoute reports whether a request may proceed without a session.
func publicRoute(method, path string) bool {
	p := strings.TrimPrefix(path, "/api/v1")
	switch {
	case method == http.MethodGet && (p == "/health" || p == "/ui-config"):
		return true
	case method == http.MethodPost && (p == "/auth/sign-in" || p == "/auth/sign-out"):
		return true
	case strings.HasPrefix(p, "/invitations/"):
		rest := strings.Split(strings.TrimPrefix(p, "/invitations/"), "/")
		return (method == http.MethodGet && len(rest) == 1) ||
			(method == http.MethodPost && len(rest) == 2 && rest[1] == "sign-up")
	}
	return false
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// sessionMiddleware resolves the session cookie, enforces CSRF on
// state-changing requests that carry a session, and rejects
// unauthenticated requests to non-public routes.
func (h *handlers) sessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info := &requestInfo{IP: r.RemoteAddr, UserAgent: truncate(r.UserAgent(), 255)}
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			info.IP = host
		}

		if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
			row, err := h.deps.Store.Queries.GetActiveSession(r.Context(), auth.HashToken(c.Value))
			switch {
			case err == nil:
				info.Principal = &principal{User: row.User, Session: row.Session, Token: c.Value}
				if time.Since(row.Session.LastSeenAt) > time.Minute {
					_ = h.deps.Store.Queries.TouchSession(r.Context(), row.Session.ID)
				}
			case !errors.Is(err, pgx.ErrNoRows):
				h.deps.Logger.ErrorContext(r.Context(), "loading session", "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
		}

		if info.Principal != nil && !safeMethod(r.Method) {
			if !h.csrf.Valid(info.Principal.Token, r.Header.Get(csrfHeader)) {
				writeError(w, http.StatusForbidden, "missing or invalid CSRF token; reload the page and try again")
				return
			}
		}

		if info.Principal == nil && !publicRoute(r.Method, r.URL.Path) {
			writeError(w, http.StatusUnauthorized, "sign in to continue")
			return
		}

		next.ServeHTTP(w, r.WithContext(withRequestInfo(r.Context(), info)))
	})
}

// sessionCookies are set on sign-in. The CSRF cookie is readable by
// JavaScript so the web app can echo it in the X-CSRF-Token header.
func (h *handlers) sessionCookies(token string, expires time.Time) []*http.Cookie {
	secure := strings.HasPrefix(h.deps.Config.Server.PublicURL, "https://")
	maxAge := int(time.Until(expires).Seconds())
	return []*http.Cookie{
		{Name: sessionCookie, Value: token, Path: "/", MaxAge: maxAge, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode},
		{Name: csrfCookie, Value: h.csrf.Token(token), Path: "/", MaxAge: maxAge, Secure: secure, SameSite: http.SameSiteLaxMode},
	}
}

func clearedCookies() []*http.Cookie {
	return []*http.Cookie{
		{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode},
		{Name: csrfCookie, Value: "", Path: "/", MaxAge: -1, SameSite: http.SameSiteLaxMode},
	}
}

// startSession creates a session row and returns the cookies to set.
func (h *handlers) startSession(ctx context.Context, q *db.Queries, userID uuid.UUID) ([]*http.Cookie, error) {
	token, hash, err := auth.NewToken()
	if err != nil {
		return nil, err
	}
	info := reqInfo(ctx)
	expires := time.Now().Add(h.deps.Config.Security.SessionTTL)
	if _, err := q.CreateSession(ctx, db.CreateSessionParams{
		UserID: userID, TokenHash: hash, Ip: info.IP, UserAgent: info.UserAgent, ExpiresAt: expires,
	}); err != nil {
		return nil, err
	}
	return h.sessionCookies(token, expires), nil
}

// joinURL builds an absolute link under server.public_url.
func (h *handlers) joinURL(path string, query url.Values) string {
	u := strings.TrimRight(h.deps.Config.Server.PublicURL, "/") + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
