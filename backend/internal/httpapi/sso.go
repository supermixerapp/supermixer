package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/config"
	"supermixer/internal/store/db"
)

// Single sign-on through OpenID Connect (Stage 5.5): the authorization code
// flow with PKCE and a nonce; what's needed between the two legs is in a
// sealed, short-lived cookie. Accounts are never matched by email: an
// identity (the provider's subject) is connected to an account by its
// owner, or creates one when the provider allows it.

const (
	ssoCookie   = "sm_sso"
	ssoStateTTL = 10 * time.Minute
)

var ssoAD = []byte("supermixer sso state")

type ssoProvider struct {
	cfg config.SSOProvider
	mu  sync.Mutex
	// discovered is set once the provider's configuration has been read.
	discovered *oidc.Provider
}

// ssoHTTP is how Supermixer talks to providers.
var ssoHTTP = &http.Client{Timeout: 15 * time.Second}

func newSSOProviders(cfg config.SSO) map[string]*ssoProvider {
	out := map[string]*ssoProvider{}
	for _, p := range cfg.Providers {
		out[p.ID] = &ssoProvider{cfg: p}
	}
	return out
}

// oidc reads the provider's configuration once (and again after a failure).
func (p *ssoProvider) oidc() (*oidc.Provider, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.discovered != nil {
		return p.discovered, nil
	}
	// The context stays with the provider to fetch its signing keys later.
	d, err := oidc.NewProvider(oidc.ClientContext(context.Background(), ssoHTTP), p.cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("couldn't read %s's configuration: %w", p.cfg.Name, err)
	}
	p.discovered = d
	return d, nil
}

func (h *handlers) oauthConfig(p *ssoProvider, d *oidc.Provider) oauth2.Config {
	return oauth2.Config{
		ClientID: p.cfg.ClientID, ClientSecret: p.cfg.ClientSecret, Endpoint: d.Endpoint(), Scopes: p.cfg.Scopes,
		RedirectURL: h.joinURL("/api/v1/auth/sso/"+p.cfg.ID+"/callback", nil),
	}
}

type ssoState struct {
	Provider string `json:"p"`
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Redirect string `json:"r"`
	// LinkUser is set when connecting the provider to a signed-in account.
	LinkUser string `json:"l,omitempty"`
	Expires  int64  `json:"e"`
}

func randomString() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// localPath keeps a redirect on this site: a path, not //host or a URL.
func localPath(p, fallback string) string {
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.ContainsAny(p, "\\\r\n") {
		return fallback
	}
	return p
}

// beginSSO sets the state cookie and returns the provider's sign-in URL.
func (h *handlers) beginSSO(w http.ResponseWriter, p *ssoProvider, redirect, linkUser string) (string, error) {
	d, err := p.oidc()
	if err != nil {
		return "", err
	}
	st := ssoState{Provider: p.cfg.ID, State: randomString(), Nonce: randomString(), Verifier: oauth2.GenerateVerifier(),
		Redirect: redirect, LinkUser: linkUser, Expires: time.Now().Add(ssoStateTTL).Unix()}
	sealed, err := h.deps.Box.SealJSON(st, ssoAD)
	if err != nil {
		return "", err
	}
	http.SetCookie(w, &http.Cookie{
		Name: ssoCookie, Value: base64.RawURLEncoding.EncodeToString(sealed), Path: "/api/v1/auth/sso/",
		MaxAge: int(ssoStateTTL.Seconds()), HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: strings.HasPrefix(h.deps.Config.Server.PublicURL, "https://"),
	})
	conf := h.oauthConfig(p, d)
	return conf.AuthCodeURL(st.State, oidc.Nonce(st.Nonce), oauth2.S256ChallengeOption(st.Verifier)), nil
}

// ssoStart: GET /auth/sso/{provider}/start?redirect=/path, from the
// sign-in page's button.
func (h *handlers) ssoStart(w http.ResponseWriter, r *http.Request) {
	p := h.sso[chi.URLParam(r, "provider")]
	if p == nil {
		h.ssoFail(w, r, "", "That sign-in provider isn't set up here")
		return
	}
	u, err := h.beginSSO(w, p, localPath(r.URL.Query().Get("redirect"), "/"), "")
	if err != nil {
		h.deps.Logger.Warn("starting single sign-on", "provider", p.cfg.ID, "err", err)
		h.ssoFail(w, r, "", "Couldn't reach "+p.cfg.Name+"; try again, or ask an instance admin to check its settings")
		return
	}
	http.Redirect(w, r, u, http.StatusFound)
}

// ssoConnect: POST /profile/identities/{provider}/connect, from Account ›
// Security. A POST, so CSRF protection applies: another site can't connect
// its own identity to your account.
func (h *handlers) ssoConnect(w http.ResponseWriter, r *http.Request) {
	pr := reqInfo(r.Context()).Principal
	p := h.sso[chi.URLParam(r, "provider")]
	if pr == nil || pr.AccessToken != nil {
		writeError(w, http.StatusUnauthorized, "sign in to continue")
		return
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "that sign-in provider isn't set up here")
		return
	}
	// Another way to sign in: confirm it's you, as for two-factor sign-in.
	var body struct {
		Password string `json:"password"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
	if err := h.confirmPassword(pr, body.Password); err != nil {
		code, _, msg, _ := errorStatus(err)
		writeError(w, code, msg)
		return
	}
	u, err := h.beginSSO(w, p, "/account/security", pr.User.ID.String())
	if err != nil {
		h.deps.Logger.Warn("connecting single sign-on", "provider", p.cfg.ID, "err", err)
		writeError(w, http.StatusBadGateway, "couldn't reach "+p.cfg.Name+"; ask an instance admin to check its settings")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"url": u})
}

// ssoFail goes back to the sign-in page (or Account › Security when
// connecting) with a message.
func (h *handlers) ssoFail(w http.ResponseWriter, r *http.Request, page, msg string) {
	if page == "" { // a sign-in, not connecting a provider
		h.deps.Metrics.SignIn("sso", false)
	}
	http.SetCookie(w, &http.Cookie{Name: ssoCookie, Value: "", Path: "/api/v1/auth/sso/", MaxAge: -1, HttpOnly: true})
	if page == "" {
		page = "/sign-in"
	}
	http.Redirect(w, r, h.joinURL(page, url.Values{"sso_error": {msg}}), http.StatusFound)
}

type ssoClaims struct {
	Email             string `json:"email"`
	EmailVerified     *bool  `json:"email_verified"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
}

// ssoCallback: GET /auth/sso/{provider}/callback, where the provider sends
// the browser back.
func (h *handlers) ssoCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "provider")
	p := h.sso[id]
	var st ssoState
	c, err := r.Cookie(ssoCookie)
	if err == nil {
		raw, derr := base64.RawURLEncoding.DecodeString(c.Value)
		if derr != nil || h.deps.Box.OpenJSON(raw, ssoAD, &st) != nil {
			err = errors.New("unreadable")
		}
	}
	if p == nil || err != nil || st.Provider != id || time.Now().Unix() > st.Expires ||
		subtle.ConstantTimeCompare([]byte(st.State), []byte(r.URL.Query().Get("state"))) != 1 {
		// Signed in already, it was probably connecting a provider: say
		// so there, since the sign-in page sends signed-in people on.
		page := ""
		if pr := reqInfo(ctx).Principal; pr != nil && pr.AccessToken == nil {
			page = "/account/security"
		}
		h.ssoFail(w, r, page, "That didn't start here, or took too long; try again")
		return
	}
	page := ""
	if st.LinkUser != "" {
		page = "/account/security"
	}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		msg := p.cfg.Name + " didn't sign you in"
		if d := q.Get("error_description"); d != "" && len(d) < 200 {
			msg += ": " + d
		}
		h.ssoFail(w, r, page, msg)
		return
	}
	d, err := p.oidc()
	if err != nil {
		h.ssoFail(w, r, page, "Couldn't reach "+p.cfg.Name)
		return
	}
	pctx := oidc.ClientContext(ctx, ssoHTTP)
	conf := h.oauthConfig(p, d)
	tok, err := conf.Exchange(pctx, q.Get("code"), oauth2.VerifierOption(st.Verifier))
	if err != nil {
		h.deps.Logger.Warn("single sign-on: exchanging the code", "provider", id, "err", err)
		h.ssoFail(w, r, page, p.cfg.Name+" didn't accept the sign-in; try again")
		return
	}
	rawID, _ := tok.Extra("id_token").(string)
	idt, err := d.Verifier(&oidc.Config{ClientID: p.cfg.ClientID}).Verify(pctx, rawID)
	if err != nil || subtle.ConstantTimeCompare([]byte(idt.Nonce), []byte(st.Nonce)) != 1 {
		h.deps.Logger.Warn("single sign-on: the ID token didn't check out", "provider", id, "err", err)
		h.ssoFail(w, r, page, p.cfg.Name+"'s answer didn't check out; try again")
		return
	}
	var claims ssoClaims
	if err := idt.Claims(&claims); err != nil {
		h.ssoFail(w, r, page, p.cfg.Name+"'s answer didn't check out; try again")
		return
	}
	// Only an address the provider vouches for, and a well-formed one.
	email := ""
	verified := claims.EmailVerified != nil && *claims.EmailVerified
	if claims.EmailVerified == nil && p.cfg.AssumeEmailVerified {
		verified = true
	}
	if e := strings.TrimSpace(claims.Email); verified && e != "" {
		if n, err := normalizeEmail(&e); err == nil && n != nil {
			email = *n
		}
	}
	if len(p.cfg.AllowedDomains) > 0 && !emailInDomains(email, p.cfg.AllowedDomains) {
		h.ssoFail(w, r, page, fmt.Sprintf("Only %s accounts can sign in here", strings.Join(p.cfg.AllowedDomains, ", ")))
		return
	}
	if st.LinkUser != "" {
		h.ssoLink(w, r, p, st, idt.Subject, email)
		return
	}
	h.ssoSignIn(w, r, p, st, idt.Subject, email, claims)
}

func emailInDomains(email string, domains []string) bool {
	at := strings.LastIndex(email, "@")
	if at < 0 {
		return false
	}
	for _, d := range domains {
		if email[at+1:] == d {
			return true
		}
	}
	return false
}

// ssoLink connects the identity to the signed-in account that asked to.
func (h *handlers) ssoLink(w http.ResponseWriter, r *http.Request, p *ssoProvider, st ssoState, subject, email string) {
	ctx := r.Context()
	pr := reqInfo(ctx).Principal
	if pr == nil || pr.AccessToken != nil || pr.User.ID.String() != st.LinkUser {
		h.ssoFail(w, r, "/account/security", "Sign in to Supermixer as the account to connect, and try again")
		return
	}
	q := h.deps.Store.Queries
	if existing, err := q.GetIdentity(ctx, db.GetIdentityParams{Provider: p.cfg.ID, Subject: subject}); err == nil {
		if existing.UserID != pr.User.ID {
			h.ssoFail(w, r, "/account/security", "That "+p.cfg.Name+" account is connected to another Supermixer account")
			return
		}
		http.Redirect(w, r, h.joinURL("/account/security", nil), http.StatusFound)
		return
	}
	if _, err := q.AddIdentity(ctx, db.AddIdentityParams{UserID: pr.User.ID, Provider: p.cfg.ID, Subject: subject, Email: email}); err != nil {
		if isUniqueViolation(err) {
			h.ssoFail(w, r, "/account/security", "Your account is already connected to "+p.cfg.Name+"; disconnect it first")
			return
		}
		h.deps.Logger.Error("connecting an identity", "err", err)
		h.ssoFail(w, r, "/account/security", "Something went wrong; try again")
		return
	}
	h.audit(ctx, nil, auditEntry{Action: "user.identity_connected", TargetType: "user", TargetID: pr.User.ID.String(), TargetName: pr.User.Username,
		Metadata: map[string]any{"provider": p.cfg.ID, "email": email}})
	h.notify(ctx, pr.User, "A sign-in provider was connected", fmt.Sprintf("%s (%s) was connected, so it can sign you in", p.cfg.Name, emailOr(email, "no email")))
	http.Redirect(w, r, h.joinURL("/account/security", url.Values{"connected": {p.cfg.ID}}), http.StatusFound)
}

func emailOr(email, fallback string) string {
	if email == "" {
		return fallback
	}
	return email
}

// ssoSignIn signs in the account the identity is connected to, or makes
// one when the provider may.
func (h *handlers) ssoSignIn(w http.ResponseWriter, r *http.Request, p *ssoProvider, st ssoState, subject, email string, claims ssoClaims) {
	ctx := r.Context()
	q := h.deps.Store.Queries
	var u db.User
	ident, err := q.GetIdentity(ctx, db.GetIdentityParams{Provider: p.cfg.ID, Subject: subject})
	switch {
	case err == nil:
		if u, err = q.GetUserByID(ctx, ident.UserID); err != nil {
			h.ssoFail(w, r, "", "Something went wrong; try again")
			return
		}
		_ = q.TouchIdentity(ctx, db.TouchIdentityParams{ID: ident.ID, Email: email})
	case !errors.Is(err, pgx.ErrNoRows):
		h.deps.Logger.Error("single sign-on: finding the identity", "err", err)
		h.ssoFail(w, r, "", "Something went wrong; try again")
		return
	case !p.cfg.CreateUsers:
		h.ssoFail(w, r, "", fmt.Sprintf("No Supermixer account is connected to this %s account. Sign in with your password and connect it under Account › Security, or ask an instance admin.", p.cfg.Name))
		return
	default:
		if u, err = h.createSSOUser(ctx, p, subject, email, claims); err != nil {
			var ae *apiError
			if errors.As(err, &ae) {
				h.ssoFail(w, r, "", ae.message)
			} else {
				h.deps.Logger.Error("single sign-on: creating the account", "err", err)
				h.ssoFail(w, r, "", "Couldn't create your account; ask an instance admin")
			}
			return
		}
	}
	if u.DisabledAt != nil {
		h.ssoFail(w, r, "", "This account is disabled; ask an instance admin")
		return
	}
	// The account's own two-factor sign-in still applies.
	if hasMFA(u) {
		c, err := h.newMFAChallenge(u, p.cfg.ID, email)
		if err != nil {
			h.ssoFail(w, r, "", "Something went wrong; try again")
			return
		}
		h.deps.Metrics.SignIn("sso", true) // the code step counts as mfa
		http.SetCookie(w, &http.Cookie{Name: ssoCookie, Value: "", Path: "/api/v1/auth/sso/", MaxAge: -1, HttpOnly: true})
		// The challenge stands in for the first factor: in a cookie only
		// POST /auth/mfa gets, not the URL (history, proxy logs).
		http.SetCookie(w, &http.Cookie{
			Name: mfaCookie, Value: c.Challenge, Path: "/api/v1/auth/mfa", MaxAge: int(mfaChallengeTTL.Seconds()),
			HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: strings.HasPrefix(h.deps.Config.Server.PublicURL, "https://"),
		})
		http.Redirect(w, r, h.joinURL("/sign-in", url.Values{"mfa": {"1"}, "redirect": {st.Redirect}}), http.StatusFound)
		return
	}
	cookies, err := h.startSession(ctx, q, u.ID, p.cfg.ID)
	if err != nil {
		h.ssoFail(w, r, "", "Something went wrong; try again")
		return
	}
	h.deps.Metrics.SignIn("sso", true)
	reqInfo(ctx).Principal = &principal{User: u}
	h.ssoAutoJoin(ctx, u, p.cfg.ID, email)
	h.audit(ctx, nil, auditEntry{Action: "user.signed_in", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"sso": p.cfg.ID}})
	http.SetCookie(w, &http.Cookie{Name: ssoCookie, Value: "", Path: "/api/v1/auth/sso/", MaxAge: -1, HttpOnly: true})
	for _, c := range cookies {
		http.SetCookie(w, c)
	}
	http.Redirect(w, r, h.joinURL(st.Redirect, nil), http.StatusFound)
}

var usernameUnsafe = regexp.MustCompile(`[^a-z0-9._-]+`)

// usernameBase makes a username (3-34 characters, leaving room for -99)
// from the provider's username or the email's local part.
func usernameBase(preferred, email string) string {
	b := preferred
	if b == "" {
		b = email
	}
	if at := strings.Index(b, "@"); at >= 0 {
		b = b[:at]
	}
	b = strings.Trim(usernameUnsafe.ReplaceAllString(strings.ToLower(b), "-"), "-._")
	if len(b) > 34 {
		b = strings.TrimRight(b[:34], "-._")
	}
	if len(b) < 3 || !usernamePattern.MatchString(b) {
		return "user"
	}
	return b
}

// createSSOUser makes an account for someone signing in through a provider
// for the first time. It has no password until they set one.
func (h *handlers) createSSOUser(ctx context.Context, p *ssoProvider, subject, email string, claims ssoClaims) (db.User, error) {
	q := h.deps.Store.Queries
	if email != "" {
		if _, err := q.GetUserByEmail(ctx, email); err == nil {
			return db.User{}, badRequest("An account with %s already exists. Sign in with its password and connect %s under Account › Security.", email, p.cfg.Name)
		}
	}
	base := usernameBase(claims.PreferredUsername, email)
	username := base
	for i := 2; ; i++ {
		taken, err := q.UsernameTaken(ctx, username)
		if err != nil {
			return db.User{}, err
		}
		if !taken {
			break
		}
		if i > 99 {
			return db.User{}, badRequest("Couldn't choose a username; ask an instance admin to create your account")
		}
		username = fmt.Sprintf("%s-%d", base, i)
	}
	// A random password no one knows: sign-in is through the provider until
	// they set one.
	hash, err := auth.HashPassword(randomString())
	if err != nil {
		return db.User{}, err
	}
	var e *string
	if email != "" {
		e = &email
	}
	name := strings.TrimSpace(claims.Name)
	if len([]rune(name)) > 64 {
		name = string([]rune(name)[:64])
	}
	var u db.User
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if u, err = q.CreateSSOUser(ctx, db.CreateSSOUserParams{Username: username, Email: e, DisplayName: name, PasswordHash: hash}); err != nil {
			return err
		}
		_, err = q.AddIdentity(ctx, db.AddIdentityParams{UserID: u.ID, Provider: p.cfg.ID, Subject: subject, Email: email})
		return err
	})
	if err != nil {
		return u, err
	}
	reqInfo(ctx).Principal = &principal{User: u}
	h.audit(ctx, nil, auditEntry{Action: "user.created", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"sso": p.cfg.ID}})
	return u, nil
}

func (h *handlers) providerName(id string) string {
	if p := h.sso[id]; p != nil {
		return p.cfg.Name
	}
	return id
}

func (h *handlers) ListIdentities(ctx context.Context, _ api.ListIdentitiesRequestObject) (api.ListIdentitiesResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListUserIdentities(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListIdentities200JSONResponse, len(rows))
	for i, r := range rows {
		out[i] = api.Identity{Id: r.ID, Provider: r.Provider, ProviderName: h.providerName(r.Provider), Email: r.Email,
			CreatedAt: r.CreatedAt, LastSignInAt: r.LastSignInAt}
	}
	return out, nil
}

func (h *handlers) DeleteIdentity(ctx context.Context, req api.DeleteIdentityRequestObject) (api.DeleteIdentityResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	var gone db.UserIdentity
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if err := q.LockUser(ctx, p.User.ID); err != nil {
			return err
		}
		rows, err := q.ListUserIdentities(ctx, p.User.ID)
		if err != nil {
			return err
		}
		// Not the last way left to sign in (providers no longer set up
		// don't count).
		usable := 0
		for _, r := range rows {
			if h.sso[r.Provider] != nil && r.ID != req.IdentityId {
				usable++
			}
		}
		if !p.User.HasPassword && usable == 0 {
			return conflict("it's the only way you sign in; set a password first (sign out, then \"Forgot your password?\")")
		}
		if gone, err = q.DeleteIdentity(ctx, db.DeleteIdentityParams{ID: req.IdentityId, UserID: p.User.ID}); errors.Is(err, pgx.ErrNoRows) {
			return notFound("identity")
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.identity_disconnected", TargetType: "user", TargetID: p.User.ID.String(), TargetName: p.User.Username,
		Metadata: map[string]any{"provider": gone.Provider}})
	return api.DeleteIdentity204Response{}, nil
}

// ssoList is the providers for the sign-in page, in configuration order.
func (h *handlers) ssoList() []struct {
	Id   string `json:"id"`
	Name string `json:"name"`
} {
	out := make([]struct {
		Id   string `json:"id"`
		Name string `json:"name"`
	}, 0, len(h.deps.Config.SSO.Providers))
	for _, p := range h.deps.Config.SSO.Providers {
		out = append(out, struct {
			Id   string `json:"id"`
			Name string `json:"name"`
		}{p.ID, p.Name})
	}
	return out
}
