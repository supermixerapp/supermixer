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
	// Token is the session cookie's value (for CSRF).
	Token string
	// AccessToken is set when the request came with a personal access
	// token instead of a session.
	AccessToken *db.AccessToken
}

// signedInWith is the single sign-on provider the session started with (or
// the session that made the access token); "" for a password.
func (p *principal) signedInWith() string {
	if p.AccessToken != nil {
		return p.AccessToken.SsoProvider
	}
	return p.Session.SsoProvider
}

// requestInfo carries what handlers need from the HTTP request, since
// strict handlers only see a context.
type requestInfo struct {
	IP        string
	UserAgent string
	Principal *principal
	// MFAChallenge is the two-factor challenge single sign-on left in a
	// cookie (sm_mfa), for POST /auth/mfa.
	MFAChallenge string
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
	// The global notice is for everyone, the homepage's visitors too.
	case method == http.MethodGet && (p == "/health" || p == "/ui-config" || p == "/notice"):
		return true
	// The private CA, to trust before signing in.
	case method == http.MethodGet && p == "/tls/ca.pem":
		return true
	case method == http.MethodPost && (p == "/auth/sign-in" || p == "/auth/mfa" || p == "/auth/sign-out" || p == "/auth/password-reset"):
		return true
	case strings.HasPrefix(p, "/auth/password-reset/") && strings.Count(p, "/") == 3 && (method == http.MethodGet || method == http.MethodPost):
		return true
	// Sign-up: asking for a link, and following it.
	case method == http.MethodPost && p == "/auth/sign-up":
		return true
	case strings.HasPrefix(p, "/auth/sign-up/") && strings.Count(p, "/") == 3 && (method == http.MethodGet || method == http.MethodPost):
		return true
	case method == http.MethodGet && strings.HasPrefix(p, "/auth/sso/"):
		return true
	case strings.HasPrefix(p, "/invitations/"):
		rest := strings.Split(strings.TrimPrefix(p, "/invitations/"), "/")
		return (method == http.MethodGet && len(rest) == 1) ||
			(method == http.MethodPost && len(rest) == 2 && rest[1] == "sign-up")
	}
	return false
}

// bearerToken returns a personal access token from Authorization: Bearer
// sbp_… (the scheme in any case, RFC 7235).
func bearerToken(r *http.Request) (string, bool) {
	scheme, tok, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	tok = strings.TrimSpace(tok)
	if !ok || !strings.EqualFold(scheme, "Bearer") || !strings.HasPrefix(tok, auth.AccessTokenPrefix) {
		return "", false
	}
	return tok, true
}

// tokenRoute reports whether an access token may make a request: anything
// its owner could, except changing how the account is secured, so a leaked
// token can't take the account over.
func tokenRoute(method, path string) bool {
	p := strings.TrimPrefix(path, "/api/v1")
	switch {
	case strings.HasPrefix(p, "/auth/"):
		return false
	case p == "/profile":
		return method == http.MethodGet
	case strings.HasPrefix(p, "/profile/"):
		return p == "/profile/permissions"
	}
	return true
}

// passwordChangeRoute reports whether a request is allowed while the user
// must choose a new password: what the change screen needs.
func passwordChangeRoute(method, path string) bool {
	p := strings.TrimPrefix(path, "/api/v1")
	switch {
	case publicRoute(method, path):
		return true
	case method == http.MethodGet && p == "/profile":
		return true
	case method == http.MethodPost && p == "/profile/password":
		return true
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
		if c, err := r.Cookie(mfaCookie); err == nil {
			info.MFAChallenge = c.Value
		}
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			info.IP = host
		}

		// A personal access token, for scripts: Authorization: Bearer sbp_…
		// It needs no CSRF token (browsers never send it on their own).
		// Other Authorization headers (a reverse proxy's Basic auth) are
		// left alone.
		if tok, ok := bearerToken(r); ok {
			row, err := h.deps.Store.Queries.GetActiveAccessToken(r.Context(), auth.HashToken(tok))
			switch {
			case errors.Is(err, pgx.ErrNoRows):
				writeError(w, http.StatusUnauthorized, "the access token is wrong, expired or revoked")
				return
			case err != nil:
				h.deps.Logger.ErrorContext(r.Context(), "loading access token", "err", err)
				writeError(w, http.StatusInternalServerError, "internal server error")
				return
			}
			t := row.AccessToken
			info.Principal = &principal{User: row.User, AccessToken: &t}
			if t.LastUsedAt == nil || time.Since(*t.LastUsedAt) > time.Minute {
				_ = h.deps.Store.Queries.TouchAccessToken(r.Context(), db.TouchAccessTokenParams{ID: t.ID, LastUsedIp: info.IP})
			}
			if !tokenRoute(r.Method, r.URL.Path) {
				writeError(w, http.StatusForbidden, "access tokens can't change account security (password, two-factor sign-in, sessions, tokens); sign in to Supermixer for that")
				return
			}
		} else if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
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

		if info.Principal != nil && info.Principal.AccessToken == nil && !safeMethod(r.Method) && !strings.HasPrefix(r.URL.Path, "/v1/") {
			if !h.csrf.Valid(info.Principal.Token, r.Header.Get(csrfHeader)) {
				writeError(w, http.StatusForbidden, "missing or invalid CSRF token; reload the page and try again")
				return
			}
		}

		if info.Principal == nil && !publicRoute(r.Method, r.URL.Path) {
			if strings.HasPrefix(r.URL.Path, "/v1/") {
				writeError(w, http.StatusUnauthorized, "use a personal access token: Authorization: Bearer sbp_… (Account › Access Tokens)")
				return
			}
			writeError(w, http.StatusUnauthorized, "sign in to continue")
			return
		}
		// Someone who must choose a new password can do that and nothing else
		// (the password they have was set by someone else, or is in a log).
		if info.Principal != nil && info.Principal.User.PasswordChangeRequired && !passwordChangeRoute(r.Method, r.URL.Path) {
			writeErrorCode(w, http.StatusForbidden, "password_change_required", "choose a new password to continue")
			return
		}

		next.ServeHTTP(w, r.WithContext(withRequestInfo(r.Context(), info)))
	})
}

// sessionCookies are set on sign-in. The CSRF cookie is readable by
// JavaScript so the web app can echo it in the X-CSRF-Token header.
func (h *handlers) sessionCookies(token string, expires time.Time) []*http.Cookie {
	maxAge := int(time.Until(expires).Seconds())
	return []*http.Cookie{
		h.cookie(&http.Cookie{Name: sessionCookie, Value: token, Path: "/", MaxAge: maxAge, HttpOnly: true}),
		h.cookie(&http.Cookie{Name: csrfCookie, Value: h.csrf.Token(token), Path: "/", MaxAge: maxAge}),
	}
}

func (h *handlers) clearedCookies() []*http.Cookie {
	return []*http.Cookie{
		h.cookie(&http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true}),
		h.cookie(&http.Cookie{Name: csrfCookie, Value: "", Path: "/", MaxAge: -1}),
	}
}

// cookie fills in what Supermixer's cookies share: Secure when it's reached
// over HTTPS, and SameSite=Lax unless the cookie says otherwise. A cookie
// is cleared with the same attributes it was set with, or browsers may keep
// it.
func (h *handlers) cookie(c *http.Cookie) *http.Cookie {
	c.Secure = strings.HasPrefix(h.deps.Config.Server.PublicURL, "https://")
	if c.SameSite == 0 {
		c.SameSite = http.SameSiteLaxMode
	}
	return c
}

// startSession creates a session row and returns the cookies to set.
// startSession signs a user in; sso is the single sign-on provider they
// came through ("" for a password).
func (h *handlers) startSession(ctx context.Context, q *db.Queries, userID uuid.UUID, sso string) ([]*http.Cookie, error) {
	token, hash, err := auth.NewToken()
	if err != nil {
		return nil, err
	}
	info := reqInfo(ctx)
	expires := time.Now().Add(h.deps.Config.Security.SessionTTL)
	if _, err := q.CreateSession(ctx, db.CreateSessionParams{
		UserID: userID, TokenHash: hash, Ip: info.IP, UserAgent: info.UserAgent, ExpiresAt: expires, SsoProvider: sso,
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
