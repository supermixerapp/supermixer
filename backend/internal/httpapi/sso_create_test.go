package httpapi

import (
	"net/url"
	"strings"
	"testing"

	"supermixer/internal/config"
)

// create_users: a new person gets an account straight away through a
// provider limited to its domains, but waits for an instance admin's
// approval through one with no allowed_domains (anyone could sign in), or
// when Instance › Sign-up requires approval. Instance › Sign-up being off
// doesn't stop it. Admins are told.
func TestSSOCreateUsersApproval(t *testing.T) {
	idp := newFakeIdP(t)
	mailer := &recordingMailer{}
	env := newTestEnvDeps(t, testDatabase(t), func(c *config.Config) {
		c.SSO.Providers = []config.SSOProvider{
			{ID: "corp", Name: "Corp", Issuer: idp.srv.URL, ClientID: "sm-corp", ClientSecret: "s", Scopes: []string{"openid", "email"},
				AllowedDomains: []string{"corp.test"}, CreateUsers: true},
			{ID: "public", Name: "Public", Issuer: idp.srv.URL, ClientID: "sm-public", ClientSecret: "s", Scopes: []string{"openid", "email"},
				CreateUsers: true},
			// A company's own tenant: no domains listed, but only its staff can sign in.
			{ID: "tenant", Name: "Tenant", Issuer: idp.srv.URL, ClientID: "sm-tenant", ClientSecret: "s", Scopes: []string{"openid", "email"},
				CreateUsers: true, RequireApproval: new(bool)},
		}
	}, func(d *Deps) { d.Mailer = mailer })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	var me struct{ ID string }
	admin.must(200, "GET", "/profile", nil, &me)
	admin.must(200, "PATCH", "/admin/users/"+me.ID, map[string]any{"email": "boss@example.com"}, nil)

	start := func(id string) string {
		return env.server.URL + "/api/v1/auth/sso/" + id + "/start?redirect=" + url.QueryEscape("/home")
	}
	signIn := func(provider, sub, email, username string) (*client, string) {
		t.Helper()
		c := env.client(t)
		idp.as(map[string]any{"sub": sub, "email": email, "email_verified": email != "", "preferred_username": username})
		end := c.sso(start(provider))
		if end.Path == "/home" {
			return c, ""
		}
		return c, end.Query().Get("sso_error")
	}
	waiting := func(username string) string {
		t.Helper()
		var users []struct {
			ID              string `json:"id"`
			Username        string `json:"username"`
			WaitingApproval bool   `json:"waiting_approval"`
		}
		admin.must(200, "GET", "/admin/users", nil, &users)
		for _, u := range users {
			if u.Username == username && u.WaitingApproval {
				return u.ID
			}
		}
		return ""
	}

	// Through the company's provider, with Instance › Sign-up off: in at once.
	if _, errMsg := signIn("corp", "c-1", "cat@corp.test", "cat"); errMsg != "" {
		t.Fatalf("corp: %s", errMsg)
	}
	mailer.waitFor(t, "boss@example.com", "New Supermixer account: cat")

	// A tenant the admin vouched for (require_approval = false): in at once.
	if _, errMsg := signIn("tenant", "t-1", "tom@anything.test", "tom"); errMsg != "" {
		t.Fatalf("tenant: %s", errMsg)
	}

	// Through a provider anyone can use, without a verified address: refused,
	// as nobody could tell them when they're approved. Refusals don't count
	// toward the sign-up limit (10 an hour from one address).
	for i := 0; i < 11; i++ {
		if _, errMsg := signIn("public", "nobody", "", "nobody"); !strings.Contains(errMsg, "verified email address") {
			t.Fatalf("public, no address: %q", errMsg)
		}
	}
	// With one: the account waits.
	_, errMsg := signIn("public", "p-1", "pat@gmail.test", "pat")
	if !strings.Contains(errMsg, "approv") {
		t.Fatalf("public: ended with %q, want waiting for approval", errMsg)
	}
	id := waiting("pat")
	if id == "" {
		t.Fatal("pat isn't waiting for approval")
	}
	mailer.waitFor(t, "boss@example.com", "Waiting for approval: pat")
	admin.must(200, "POST", "/admin/users/"+id+"/approval", nil, nil)
	if _, errMsg := signIn("public", "p-1", "pat@gmail.test", "pat"); errMsg != "" {
		t.Fatalf("after approval: %s", errMsg)
	}

	// Recorded as a sign-up, with the address; the company's as created.
	var audit struct {
		Entries []struct {
			Action     string
			TargetName string         `json:"target_name"`
			Metadata   map[string]any `json:"metadata"`
		} `json:"entries"`
	}
	admin.must(200, "GET", "/admin/audit-logs?limit=100", nil, &audit)
	actions := map[string]string{}
	for _, e := range audit.Entries {
		if e.Action == "user.signed_up" || e.Action == "user.created" {
			actions[e.TargetName] = e.Action
			if e.TargetName == "pat" && e.Metadata["email"] != "pat@gmail.test" {
				t.Errorf("pat's sign-up metadata: %v", e.Metadata)
			}
		}
	}
	if actions["pat"] != "user.signed_up" || actions["cat"] != "user.created" || actions["tom"] != "user.created" || actions["nobody"] != "" {
		t.Errorf("audit: %v", actions)
	}

	// Instance › Sign-up requires approval: the company's provider waits too.
	admin.must(200, "PUT", "/admin/sign-up", map[string]any{"enabled": false, "allowed_domains": []string{}, "notify_admins": true, "require_approval": true}, nil)
	if _, errMsg := signIn("corp", "c-2", "dee@corp.test", "dee"); !strings.Contains(errMsg, "approv") || waiting("dee") == "" {
		t.Fatalf("corp with approval required: %q", errMsg)
	}
}

// Without email set up, a provider anyone can use can't make accounts: they
// would wait for approval with nobody told. A vouched-for one still can.
func TestSSOCreateUsersWithoutEmail(t *testing.T) {
	idp := newFakeIdP(t)
	env := newTestEnvWith(t, func(c *config.Config) {
		c.SSO.Providers = []config.SSOProvider{
			{ID: "public", Name: "Public", Issuer: idp.srv.URL, ClientID: "sm-public", ClientSecret: "s", Scopes: []string{"openid", "email"},
				CreateUsers: true},
			{ID: "corp", Name: "Corp", Issuer: idp.srv.URL, ClientID: "sm-corp", ClientSecret: "s", Scopes: []string{"openid", "email"},
				AllowedDomains: []string{"corp.test"}, CreateUsers: true},
		}
	})
	start := func(id string) string {
		return env.server.URL + "/api/v1/auth/sso/" + id + "/start?redirect=" + url.QueryEscape("/home")
	}
	idp.as(map[string]any{"sub": "p-1", "email": "pat@gmail.test", "email_verified": true, "preferred_username": "pat"})
	if end := env.client(t).sso(start("public")); !strings.Contains(end.Query().Get("sso_error"), "can't send email") {
		t.Fatalf("public without email: ended at %s", end)
	}
	idp.as(map[string]any{"sub": "c-1", "email": "cat@corp.test", "email_verified": true, "preferred_username": "cat"})
	if end := env.client(t).sso(start("corp")); end.Path != "/home" {
		t.Fatalf("corp without email: ended at %s (%s)", end, end.Query().Get("sso_error"))
	}
}
