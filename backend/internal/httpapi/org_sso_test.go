package httpapi

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"supermixer/internal/config"
)

func TestOrganizationSSO(t *testing.T) {
	idp := newFakeIdP(t)
	providers := func(c *config.Config) {
		c.SSO.Providers = []config.SSOProvider{{ID: "corp", Name: "Corp", Issuer: idp.srv.URL, ClientID: "sm-corp",
			ClientSecret: "s", Scopes: []string{"openid", "email"}, AllowedDomains: []string{"corp.test"}, CreateUsers: true}}
	}
	env := newTestEnvWith(t, providers)
	start := env.server.URL + "/api/v1/auth/sso/corp/start?redirect=" + url.QueryEscape("/")

	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Acme"}, nil)
	base := "/organizations/acme/sso"
	var settings struct {
		Provider     *string
		Required     bool
		Providers    []struct{ ID, Name string }
		SignedInWith *string `json:"signed_in_with"`
	}
	admin.must(200, "GET", base, nil, &settings)
	if settings.Provider != nil || len(settings.Providers) != 1 || settings.SignedInWith != nil {
		t.Fatalf("settings = %+v", settings)
	}
	body := func(required bool, role any, domains ...string) map[string]any {
		if domains == nil {
			domains = []string{}
		}
		return map[string]any{"provider": "corp", "required": required, "join_role": role, "join_domains": domains}
	}
	admin.must(400, "PUT", base, map[string]any{"provider": "nope", "required": false, "join_role": nil, "join_domains": []string{}}, nil)
	// Requiring it without having signed in with it would lock the admin out.
	admin.must(400, "PUT", base, body(true, nil), nil)
	admin.must(400, "PUT", base, body(false, "owner"), nil)

	// The admin connects Corp, then signs in with it.
	var conn struct{ URL string }
	admin.must(200, "POST", "/profile/identities/corp/connect", map[string]string{"password": adminPassword}, &conn)
	idp.as(map[string]any{"sub": "admin-corp", "email": "admin@corp.test", "email_verified": true})
	admin.sso(conn.URL)
	viaSSO := env.client(t)
	viaSSO.sso(start)
	viaSSO.must(200, "GET", base, nil, &settings)
	if settings.SignedInWith == nil || *settings.SignedInWith != "corp" {
		t.Fatalf("signed_in_with = %v", settings.SignedInWith)
	}
	viaSSO.must(200, "PUT", base, body(true, "developer", "Corp.test", "@corp.test"), &settings)

	// The password session can see the organization's name, nothing else.
	var orgs []struct {
		Slug                string
		SsoRequiredProvider *string `json:"sso_required_provider"`
		SsoSatisfied        bool    `json:"sso_satisfied"`
	}
	admin.must(200, "GET", "/organizations", nil, &orgs)
	if len(orgs) != 1 || orgs[0].SsoRequiredProvider == nil || orgs[0].SsoSatisfied {
		t.Fatalf("organizations = %+v", orgs)
	}
	var e struct{ Code, Message string }
	admin.must(403, "GET", "/organizations/acme/members", nil, &e)
	if e.Code != "sso_required" || !strings.Contains(e.Message, "Corp") {
		t.Fatalf("error = %+v", e)
	}
	viaSSO.must(200, "GET", "/organizations/acme/members", nil, nil)

	// Access tokens: as the session that made them.
	token := func(c *client) string {
		var tok struct{ Token string }
		c.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "t", "expires_in_days": 1}, &tok)
		return tok.Token
	}
	for tok, want := range map[string]int{token(admin): 403, token(viaSSO): 200} {
		req, _ := http.NewRequest("GET", env.server.URL+"/api/v1/organizations/acme/members", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("token: %d, want %d", resp.StatusCode, want)
		}
	}

	// People from the domain join by themselves, as developers.
	idp.as(map[string]any{"sub": "zed-1", "email": "zed@corp.test", "email_verified": true})
	zed := env.client(t)
	zed.sso(start)
	var members []struct{ Role, Username string }
	viaSSO.must(200, "GET", "/organizations/acme/members", nil, &members)
	joined := false
	for _, m := range members {
		joined = joined || (m.Username == "zed" && m.Role == "developer")
	}
	if !joined {
		t.Fatalf("members = %+v", members)
	}
	zed.must(200, "GET", "/organizations/acme/members", nil, nil)
	// Other domains don't.
	viaSSO.must(200, "PUT", base, body(true, "developer", "other.test"), nil)
	idp.as(map[string]any{"sub": "yan-1", "email": "yan@corp.test", "email_verified": true})
	yan := env.client(t)
	yan.sso(start)
	yan.must(404, "GET", "/organizations/acme/members", nil, nil)

	// A provider removed from the settings isn't enforced (nobody could
	// sign in with it).
	later := newTestEnvSharing(t, env, nil)
	again := later.client(t)
	again.signIn("admin", adminPassword)
	again.must(200, "GET", "/organizations/acme/members", nil, nil)
	again.must(200, "GET", base, nil, &struct {
		ProviderMissing bool `json:"provider_missing"`
	}{})
}
