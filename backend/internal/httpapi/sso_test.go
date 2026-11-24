package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"supermixer/internal/auth"
	"supermixer/internal/config"
)

// fakeIdP is enough of an OpenID Connect provider to sign people in: the
// next sign-in is as whoever claims says.
type fakeIdP struct {
	srv    *httptest.Server
	key    *rsa.PrivateKey
	mu     sync.Mutex
	claims map[string]any
	codes  map[string]fakeCode
}

type fakeCode struct {
	nonce, challenge, clientID string
	claims                     map[string]any
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	f := &fakeIdP{key: key, codes: map[string]fakeCode{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize", "token_endpoint": f.srv.URL + "/token",
			"jwks_uri": f.srv.URL + "/jwks", "id_token_signing_alg_values_supported": []string{"RS256"},
			"response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	})
	// Signs in straight away, as whoever claims says, and sends the browser back.
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("nonce") == "" {
			http.Error(w, "PKCE and a nonce are required", 400)
			return
		}
		f.mu.Lock()
		code := randomString()
		f.codes[code] = fakeCode{nonce: q.Get("nonce"), challenge: q.Get("code_challenge"), clientID: q.Get("client_id"), claims: f.claims}
		f.mu.Unlock()
		back, _ := url.Parse(q.Get("redirect_uri"))
		v := back.Query()
		v.Set("code", code)
		v.Set("state", q.Get("state"))
		back.RawQuery = v.Encode()
		http.Redirect(w, r, back.String(), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		c, ok := f.codes[r.PostForm.Get("code")]
		delete(f.codes, r.PostForm.Get("code"))
		f.mu.Unlock()
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != c.challenge {
			http.Error(w, `{"error":"invalid_grant"}`, 400)
			return
		}
		claims := map[string]any{"iss": f.srv.URL, "aud": c.clientID, "exp": time.Now().Add(time.Minute).Unix(),
			"iat": time.Now().Unix(), "nonce": c.nonce}
		for k, v := range c.claims {
			claims[k] = v
		}
		signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: key, KeyID: "k1"}}, nil)
		payload, _ := json.Marshal(claims)
		jws, _ := signer.Sign(payload)
		idToken, _ := jws.CompactSerialize()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 60, "id_token": idToken})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIdP) as(claims map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claims = claims
}

// sso follows a single sign-on from its first redirect to where Supermixer
// finally sends the browser, which it returns.
func (c *client) sso(startURL string) *url.URL {
	c.t.Helper()
	noFollow := &http.Client{Jar: c.http.Jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	next := startURL
	for i := 0; i < 5; i++ {
		resp, err := noFollow.Get(next)
		if err != nil {
			c.t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusFound {
			c.t.Fatalf("GET %s = %d", next, resp.StatusCode)
		}
		loc, _ := url.Parse(resp.Header.Get("Location"))
		// Supermixer's links use server.public_url; send them to the test server.
		if loc.Host == "supermixer.test" {
			if !strings.HasPrefix(loc.Path, "/api/") {
				return loc
			}
			srv, _ := url.Parse(c.env.server.URL)
			loc.Scheme, loc.Host = srv.Scheme, srv.Host
		}
		next = loc.String()
	}
	c.t.Fatal("too many redirects")
	return nil
}

func TestSSO(t *testing.T) {
	idp := newFakeIdP(t)
	env := newTestEnvWith(t, func(c *config.Config) {
		c.SSO.Providers = []config.SSOProvider{
			{ID: "corp", Name: "Corp", Issuer: idp.srv.URL, ClientID: "sm-corp", ClientSecret: "s", Scopes: []string{"openid", "email"},
				AllowedDomains: []string{"corp.test"}, CreateUsers: true},
			{ID: "partner", Name: "Partner", Issuer: idp.srv.URL, ClientID: "sm-partner", ClientSecret: "s", Scopes: []string{"openid"}},
		}
	})
	var ui struct {
		SsoProviders []struct{ ID, Name string } `json:"sso_providers"`
	}
	env.client(t).must(200, "GET", "/ui-config", nil, &ui)
	if len(ui.SsoProviders) != 2 || ui.SsoProviders[0].Name != "Corp" {
		t.Fatalf("sso_providers = %+v", ui.SsoProviders)
	}
	start := func(id, redirect string) string {
		return env.server.URL + "/api/v1/auth/sso/" + id + "/start?redirect=" + url.QueryEscape(redirect)
	}

	// A new person from an allowed domain gets an account, without a password.
	ann := env.client(t)
	idp.as(map[string]any{"sub": "ann-1", "email": "Ann@corp.test", "email_verified": true, "name": "Ann Lee", "preferred_username": "ann.lee"})
	if end := ann.sso(start("corp", "/org/x")); end.Path != "/org/x" {
		t.Fatalf("ended at %s", end)
	}
	var me struct {
		Username    string
		Email       string
		DisplayName string `json:"display_name"`
		HasPassword bool   `json:"has_password"`
	}
	ann.must(200, "GET", "/profile", nil, &me)
	if me.Username != "ann.lee" || me.Email != "ann@corp.test" || me.DisplayName != "Ann Lee" || me.HasPassword {
		t.Fatalf("ann = %+v", me)
	}
	// The second time, the same account.
	again := env.client(t)
	again.sso(start("corp", "/"))
	again.must(200, "GET", "/profile", nil, &me)
	if me.Username != "ann.lee" {
		t.Fatalf("second sign-in as %s", me.Username)
	}
	// Her only way in can't be disconnected.
	var ids []struct{ ID, Provider string }
	ann.must(200, "GET", "/profile/identities", nil, &ids)
	if len(ids) != 1 || ids[0].Provider != "corp" {
		t.Fatalf("identities = %+v", ids)
	}
	ann.must(409, "DELETE", "/profile/identities/"+ids[0].ID, nil, nil)
	// A provider that's no longer set up doesn't count as a way in.
	conn0 := openTestDB(t, env.dbURL)
	if _, err := conn0.Exec(context.Background(), `insert into user_identities (user_id, provider, subject)
		select id, 'gone', 'ann-old' from users where username = 'ann.lee'`); err != nil {
		t.Fatal(err)
	}
	ann.must(409, "DELETE", "/profile/identities/"+ids[0].ID, nil, nil)
	// Without a password, a recent sign-in confirms it's her.
	ann.must(200, "POST", "/profile/mfa/setup", map[string]string{"password": ""}, nil)
	db := openTestDB(t, env.dbURL)
	if _, err := db.Exec(context.Background(), `update sessions set created_at = now() - interval '1 hour'
		where user_id = (select id from users where username = 'ann.lee')`); err != nil {
		t.Fatal(err)
	}
	ann.must(403, "POST", "/profile/mfa/setup", map[string]string{"password": ""}, nil)

	ssoError := func(u *url.URL) string { return u.Query().Get("sso_error") }
	// Other domains, unverified emails and unknown people are turned away.
	idp.as(map[string]any{"sub": "bob-1", "email": "bob@other.test", "email_verified": true})
	if e := ssoError(env.client(t).sso(start("corp", "/"))); !strings.Contains(e, "corp.test") {
		t.Errorf("other domain: %q", e)
	}
	idp.as(map[string]any{"sub": "eve-1", "email": "eve@corp.test", "email_verified": false})
	if e := ssoError(env.client(t).sso(start("corp", "/"))); !strings.Contains(e, "corp.test") {
		t.Errorf("unverified email: %q", e)
	}
	idp.as(map[string]any{"sub": "eve-2", "email": "eve@corp.test"}) // no email_verified at all
	if e := ssoError(env.client(t).sso(start("corp", "/"))); !strings.Contains(e, "corp.test") {
		t.Errorf("email without email_verified: %q", e)
	}
	idp.as(map[string]any{"sub": "pat-1"})
	if e := ssoError(env.client(t).sso(start("partner", "/"))); !strings.Contains(e, "No Supermixer account") {
		t.Errorf("unknown person: %q", e)
	}
	// Never matched by email: someone at the provider with an existing
	// account's address doesn't get into it.
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(200, "PATCH", "/profile", map[string]any{"email": "admin@corp.test"}, nil)
	idp.as(map[string]any{"sub": "imposter", "email": "ADMIN@Corp.test", "email_verified": true})
	if e := ssoError(env.client(t).sso(start("corp", "/"))); !strings.Contains(e, "already exists") {
		t.Errorf("existing email: %q", e)
	}

	// Connecting takes a signed-in session, a CSRF-protected POST and the
	// password.
	env.client(t).must(401, "POST", "/profile/identities/partner/connect", nil, nil)
	var conn struct{ URL string }
	admin.must(400, "POST", "/profile/identities/partner/connect", map[string]string{"password": "wrong"}, nil)
	admin.must(200, "POST", "/profile/identities/partner/connect", map[string]string{"password": "admin"}, &conn)
	idp.as(map[string]any{"sub": "pat-1"})
	if end := admin.sso(conn.URL); end.Path != "/account/security" || ssoError(end) != "" {
		t.Fatalf("connect ended at %s", end)
	}
	pat := env.client(t)
	pat.sso(start("partner", "/"))
	pat.must(200, "GET", "/profile", nil, &me)
	if me.Username != "admin" {
		t.Fatalf("partner sign-in as %s", me.Username)
	}
	// The same provider account can't be connected to another account.
	ann.must(403, "POST", "/profile/identities/partner/connect", map[string]string{}, nil) // signed in an hour ago
	idp.as(map[string]any{"sub": "ann-1", "email": "ann@corp.test", "email_verified": true})
	fresh := env.client(t)
	fresh.sso(start("corp", "/"))
	idp.as(map[string]any{"sub": "pat-1"})
	fresh.must(200, "POST", "/profile/identities/partner/connect", map[string]string{}, &conn) // no password: a recent sign-in
	if e := ssoError(fresh.sso(conn.URL)); !strings.Contains(e, "another Supermixer account") {
		t.Errorf("connecting someone else's: %q", e)
	}

	// A callback that didn't start in this browser goes nowhere.
	stray := env.client(t)
	noFollow := &http.Client{Jar: stray.http.Jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, _ := noFollow.Get(env.server.URL + "/api/v1/auth/sso/corp/callback?code=x&state=y")
	loc, _ := url.Parse(resp.Header.Get("Location"))
	if !strings.Contains(ssoError(loc), "didn't start here") {
		t.Errorf("stray callback: %s", loc)
	}

	// Two-factor sign-in still applies after the provider.
	var setup struct{ Secret string }
	admin.must(200, "POST", "/profile/mfa/setup", map[string]string{"password": "admin"}, &setup)
	secret, _ := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ReplaceAll(setup.Secret, " ", ""))
	admin.must(200, "POST", "/profile/mfa/enable", map[string]string{"code": auth.TOTPCode(secret, auth.TOTPStep(time.Now()))}, nil)
	mfa := env.client(t)
	end := mfa.sso(start("partner", "/org/y"))
	if end.Path != "/sign-in" || end.Query().Get("mfa") != "1" || end.Query().Get("redirect") != "/org/y" {
		t.Fatalf("with 2FA, ended at %s", end)
	}
	mfa.must(401, "GET", "/profile", nil, nil)
	// The challenge is in a cookie for /auth/mfa, not the URL.
	mfa.must(200, "POST", "/auth/mfa", map[string]string{"code": auth.TOTPCode(secret, auth.TOTPStep(time.Now())+1)}, nil)
	mfa.must(200, "GET", "/profile", nil, nil)
}

func TestUsernameBase(t *testing.T) {
	for in, want := range map[[2]string]string{
		{"ann.lee", ""}:               "ann.lee",
		{"", "jdoe"}:                  "jdoe", // no @ at all
		{"", "Mary.O'Neil@corp.test"}: "mary.o-neil",
		{"abcdefghijklmnopqrstuvwxyzabcdefg-hijkl", ""}: "abcdefghijklmnopqrstuvwxyzabcdefg",
		{"x", ""}:            "user",
		{"", ""}:             "user",
		{"--__..", ""}:       "user",
		{"Ünïcødé Näme", ""}: "n-c-d-n-me",
	} {
		if got := usernameBase(in[0], in[1]); got != want || !usernamePattern.MatchString(got) {
			t.Errorf("usernameBase(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}
