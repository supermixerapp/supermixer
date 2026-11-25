package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/config"
)

// fakeGitHub stands in for GitHub Enterprise Server (github_url): it signs
// in straight away as whoever `as` says, and answers GET /user and
// GET /user/emails for the token it gave.
type fakeGitHub struct {
	srv    *httptest.Server
	mu     sync.Mutex
	user   githubUser
	emails []githubEmail
	codes  map[string]bool
	// scopes asked for at the last sign-in.
	scopes string
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	t.Helper()
	f := &fakeGitHub{codes: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f.mu.Lock()
		code := randomString()
		f.codes[code] = true
		f.scopes = q.Get("scope")
		f.mu.Unlock()
		back, _ := url.Parse(q.Get("redirect_uri"))
		v := back.Query()
		v.Set("code", code)
		v.Set("state", q.Get("state"))
		back.RawQuery = v.Encode()
		http.Redirect(w, r, back.String(), http.StatusFound)
	})
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		ok := f.codes[r.PostForm.Get("code")] && r.PostForm.Get("client_id") == "gh-client" && r.PostForm.Get("client_secret") == "gh-secret"
		delete(f.codes, r.PostForm.Get("code"))
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "bad_verification_code"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "gho_test", "token_type": "bearer", "scope": "user:email"})
	})
	api := func(path string, body func() any) {
		mux.HandleFunc("/api/v3"+path, func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer gho_test" {
				http.Error(w, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
				return
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(body())
		})
	}
	api("/user", func() any { return f.user })
	api("/user/emails", func() any { return f.emails })
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) as(user githubUser, emails ...githubEmail) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.user, f.emails = user, emails
}

func TestGitHubSignIn(t *testing.T) {
	gh := newFakeGitHub(t)
	mailer := &recordingMailer{}
	env := newTestEnvDeps(t, testDatabase(t), func(c *config.Config) {
		c.SSO.Providers = []config.SSOProvider{{ID: "github", Name: "GitHub", Type: "github", GitHubURL: gh.srv.URL,
			ClientID: "gh-client", ClientSecret: "gh-secret", Scopes: []string{"user:email"}}}
	}, func(d *Deps) { d.Mailer = mailer })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	var adminProfile struct{ ID string }
	admin.must(200, "GET", "/profile", nil, &adminProfile)
	admin.must(200, "PATCH", "/admin/users/"+adminProfile.ID, map[string]any{"email": "boss@example.com"}, nil)
	start := env.server.URL + "/api/v1/auth/sso/github/start?redirect=" + url.QueryEscape("/dashboard")
	signUp := func(on, approval bool, domains ...string) {
		t.Helper()
		if domains == nil {
			domains = []string{}
		}
		admin.must(200, "PUT", "/admin/sign-up", map[string]any{"enabled": on, "allowed_domains": domains, "notify_admins": true, "require_approval": approval}, nil)
	}
	type provider struct {
		ID              string `json:"id"`
		Type            string `json:"type"`
		CreatesAccounts bool   `json:"creates_accounts"`
	}
	providers := func() []provider {
		var ui struct {
			Providers []provider `json:"sso_providers"`
		}
		env.client(t).must(200, "GET", "/ui-config", nil, &ui)
		return ui.Providers
	}
	failure := func(end *url.URL) string {
		t.Helper()
		if end.Path != "/sign-in" {
			t.Fatalf("ended at %s, want the sign-in page", end)
		}
		return end.Query().Get("sso_error")
	}
	octo := githubUser{ID: 583231, Login: "octocat", Name: "The Octocat"}
	verified := githubEmail{Email: "Octo@Example.com", Primary: true, Verified: true}

	// Sign-up off: no account for someone new.
	if p := providers(); len(p) != 1 || p[0].Type != "github" || p[0].CreatesAccounts {
		t.Fatalf("providers = %+v", p)
	}
	gh.as(octo, verified)
	c := env.client(t)
	if msg := failure(c.sso(start)); !strings.Contains(msg, "No Supermixer account is connected to this GitHub account") {
		t.Fatalf("sign-up off: %q", msg)
	}
	if gh.scopes != "user:email" {
		t.Errorf("asked for %q", gh.scopes)
	}

	// Sign-up on: an account, signed in, named after the GitHub account.
	signUp(true, false, "example.com")
	if p := providers(); !p[0].CreatesAccounts {
		t.Fatal("GitHub doesn't say it creates accounts with sign-up on")
	}
	if end := c.sso(start); end.Path != "/dashboard" {
		t.Fatalf("ended at %s", end)
	}
	var me struct {
		ID          string `json:"id"`
		Username    string
		Email       string
		DisplayName string `json:"display_name"`
		HasPassword bool   `json:"has_password"`
	}
	c.must(200, "GET", "/profile", nil, &me)
	if me.Username != "octocat" || me.Email != "octo@example.com" || me.DisplayName != "The Octocat" || me.HasPassword {
		t.Fatalf("profile = %+v", me)
	}
	mailer.waitFor(t, "boss@example.com", "New Supermixer account: octocat")

	// People can't join an organization by signing in with GitHub, with or
	// without domains: anyone has an account there, and verified addresses
	// go stale. Choosing GitHub without joining is fine.
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Gh Org"}, nil)
	for _, domains := range [][]string{{}, {"example.com"}} {
		var refused struct{ Message string }
		if s := admin.do("PUT", "/organizations/gh-org/sso", map[string]any{"provider": "github", "required": false, "join_role": "developer", "join_domains": domains}, &refused); s != 400 ||
			!strings.Contains(refused.Message, "Invite them instead") {
			t.Fatalf("joining through GitHub (domains %v) = %d %+v", domains, s, refused)
		}
	}
	admin.must(200, "PUT", "/organizations/gh-org/sso", map[string]any{"provider": "github", "required": false, "join_role": nil, "join_domains": []string{}}, nil)
	// Even settings stored before it was refused don't let anyone join.
	conn, err := pgx.Connect(context.Background(), env.dbURL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(context.Background(), `UPDATE organizations SET sso_join_role = 'developer', sso_join_domains = '{example.com}' WHERE slug = 'gh-org'`)
	conn.Close(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// The next time, the same account, though the username and address changed
	// on GitHub: it's the user ID that counts. It doesn't join Gh Org.
	gh.as(githubUser{ID: 583231, Login: "octocat-renamed"}, githubEmail{Email: "new@example.com", Primary: true, Verified: true})
	again := env.client(t)
	again.sso(start)
	var me2 struct{ ID string }
	again.must(200, "GET", "/profile", nil, &me2)
	if me2.ID != me.ID {
		t.Fatal("a different account the second time")
	}
	var orgs []struct{ Slug, Role string }
	again.must(200, "GET", "/organizations", nil, &orgs)
	for _, o := range orgs {
		if o.Slug == "gh-org" {
			t.Fatalf("joined Gh Org by signing in with GitHub: %+v", orgs)
		}
	}

	// No verified address, an address outside the allowed domains, or one
	// that's another account's: no account.
	for _, tc := range []struct {
		user   githubUser
		emails []githubEmail
		want   string
	}{
		{githubUser{ID: 2, Login: "unverified"}, []githubEmail{{Email: "u@example.com", Primary: true}}, "didn't share a verified email address"},
		{githubUser{ID: 3, Login: "elsewhere"}, []githubEmail{{Email: "e@other.net", Primary: true, Verified: true}}, "Only addresses at example.com"},
		{githubUser{ID: 4, Login: "taken"}, []githubEmail{{Email: "boss@example.com", Primary: true, Verified: true}}, "already exists"},
	} {
		gh.as(tc.user, tc.emails...)
		if msg := failure(env.client(t).sso(start)); !strings.Contains(msg, tc.want) {
			t.Errorf("%s: %q, want %q", tc.user.Login, msg, tc.want)
		}
	}

	// A verified address that isn't the primary one is used if the primary isn't verified.
	gh.as(githubUser{ID: 5, Login: "second"}, githubEmail{Email: "p@other.net", Primary: true}, githubEmail{Email: "second@example.com", Verified: true})
	if end := env.client(t).sso(start); end.Path != "/dashboard" {
		t.Fatalf("second address: ended at %s (%s)", end, end.Query().Get("sso_error"))
	}

	// With approval required, the account waits and can't sign in.
	signUp(true, true)
	gh.as(githubUser{ID: 6, Login: "waits"}, githubEmail{Email: "waits@anywhere.org", Primary: true, Verified: true})
	w := env.client(t)
	if msg := failure(w.sso(start)); !strings.Contains(msg, "waiting for an instance admin's approval") {
		t.Fatalf("waiting: %q", msg)
	}
	w.must(401, "GET", "/profile", nil, nil)
	mailer.waitFor(t, "boss@example.com", "Waiting for approval: waits")
	// Another GitHub account with the waiting account's address is told it's
	// waiting, not to sign in with a password it can't use yet.
	gh.as(githubUser{ID: 7, Login: "waits-too"}, githubEmail{Email: "waits@anywhere.org", Primary: true, Verified: true})
	if msg := failure(env.client(t).sso(start)); !strings.Contains(msg, "waiting for an instance admin's approval") {
		t.Fatalf("an address that's waiting: %q", msg)
	}
	gh.as(githubUser{ID: 6, Login: "waits"}, githubEmail{Email: "waits@anywhere.org", Primary: true, Verified: true})
	var users []struct {
		ID              string `json:"id"`
		Username        string `json:"username"`
		WaitingApproval bool   `json:"waiting_approval"`
	}
	admin.must(200, "GET", "/admin/users", nil, &users)
	var waitsID string
	for _, u := range users {
		if u.Username == "waits" && u.WaitingApproval {
			waitsID = u.ID
		}
	}
	if waitsID == "" {
		t.Fatalf("waits isn't waiting: %+v", users)
	}
	admin.must(200, "POST", "/admin/users/"+waitsID+"/approval", nil, nil)
	if end := w.sso(start); end.Path != "/dashboard" {
		t.Fatalf("after approval: ended at %s (%s)", end, end.Query().Get("sso_error"))
	}

	// Recorded as sign-ups.
	var audit struct {
		Entries []struct {
			Action   string
			Metadata map[string]any
		} `json:"entries"`
	}
	admin.must(200, "GET", "/admin/audit-logs?action=user.signed_up", nil, &audit)
	if len(audit.Entries) != 3 || audit.Entries[0].Metadata["sso"] != "github" {
		t.Errorf("audit = %+v", audit.Entries)
	}
}

func TestPickGitHubEmail(t *testing.T) {
	for want, emails := range map[string][]githubEmail{
		"p@x.io": {{Email: "a@x.io", Verified: true}, {Email: "P@x.io", Primary: true, Verified: true}},
		"a@x.io": {{Email: "p@x.io", Primary: true}, {Email: "a@x.io", Verified: true}, {Email: "b@x.io", Verified: true}},
		"":       {{Email: "p@x.io", Primary: true}, {Email: "not an address", Verified: true}},
		// GitHub's no-reply addresses can't receive mail, on github.com or Enterprise Server.
		"real@x.io": {{Email: "1+octo@users.noreply.github.com", Primary: true, Verified: true}, {Email: "real@x.io", Verified: true}},
		"none":      {{Email: "1+octo@users.noreply.github.com", Verified: true}, {Email: "2+o@USERS.NOREPLY.github.example.com", Verified: true}},
	} {
		if want == "none" {
			want = ""
		}
		if got := pickGitHubEmail(emails); got != want {
			t.Errorf("pickGitHubEmail(%+v) = %q, want %q", emails, got, want)
		}
	}
}
