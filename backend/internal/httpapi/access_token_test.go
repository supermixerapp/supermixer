package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestAccessTokens(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)

	admin.must(400, "POST", "/profile/access-tokens", map[string]any{"name": " ", "expires_in_days": 30}, nil)
	admin.must(400, "POST", "/profile/access-tokens", map[string]any{"name": "CI", "expires_in_days": 400}, nil)
	var created struct {
		ID     string `json:"id"`
		Token  string `json:"token"`
		Prefix string `json:"prefix"`
	}
	admin.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "CI", "expires_in_days": 30}, &created)
	if !strings.HasPrefix(created.Token, "sbp_") || len(created.Token) != 44 || !strings.HasPrefix(created.Token, created.Prefix) {
		t.Fatalf("token = %+v", created)
	}
	var list []map[string]any
	admin.must(200, "GET", "/profile/access-tokens", nil, &list)
	if len(list) != 1 || list[0]["token"] != nil || list[0]["last_used_at"] != nil {
		t.Fatalf("list = %v", list)
	}

	// The token acts as its owner, without a session or CSRF token.
	ci := env.client(t)
	ci.bearer = created.Token
	ci.must(200, "GET", "/profile", nil, nil)
	ci.must(201, "POST", "/organizations", map[string]string{"name": "Scripted"}, nil)
	admin.must(200, "GET", "/profile/access-tokens", nil, &list)
	if list[0]["last_used_at"] == nil {
		t.Error("last_used_at not set")
	}
	var audit struct {
		Entries []struct {
			Action   string
			Metadata map[string]any
		} `json:"entries"`
	}
	admin.must(200, "GET", "/organizations/scripted/audit-logs", nil, &audit)
	if len(audit.Entries) == 0 || !strings.Contains(audit.Entries[len(audit.Entries)-1].Metadata["access_token"].(string), "CI (sbp_") {
		t.Errorf("audit = %+v", audit.Entries)
	}

	// But it can't change how the account is secured.
	for _, r := range []struct{ method, path string }{
		{"POST", "/profile/password"}, {"POST", "/profile/mfa/setup"}, {"GET", "/profile/sessions"},
		{"POST", "/profile/access-tokens"}, {"DELETE", "/profile/access-tokens/" + created.ID}, {"PATCH", "/profile"},
	} {
		if got := ci.do(r.method, r.path, map[string]any{}, nil); got != 403 {
			t.Errorf("%s %s with a token = %d, want 403", r.method, r.path, got)
		}
	}
	bad := env.client(t)
	for _, h := range []string{"sbp_" + strings.Repeat("0", 40), "not-a-token"} {
		bad.bearer = h
		if got := bad.do("GET", "/profile", nil, nil); got != 401 {
			t.Errorf("bearer %q = %d", h, got)
		}
	}
	// Not through the admin API either: an admin's token can't set the
	// admin's own password or email, or sign their sessions out.
	var adminMe struct{ ID string }
	admin.must(200, "GET", "/profile", nil, &adminMe)
	ci.must(403, "POST", "/admin/users/"+adminMe.ID+"/password", map[string]any{"password": "taken-over-1-secret"}, nil)
	ci.must(403, "PATCH", "/admin/users/"+adminMe.ID, map[string]any{"email": "evil@example.com"}, nil)
	ci.must(403, "DELETE", "/admin/users/"+adminMe.ID+"/sessions", nil, nil)
	admin.must(200, "GET", "/profile", nil, nil)
	// The scheme in any case; other Authorization headers (a proxy's Basic
	// auth) are ignored rather than refused.
	lower := env.client(t)
	lower.bearer = created.Token
	req, _ := http.NewRequest("GET", env.server.URL+"/api/v1/profile", nil)
	req.Header.Set("Authorization", "bearer "+created.Token)
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 200 {
		t.Errorf("lowercase bearer: %v %v", resp.StatusCode, err)
	}
	req, _ = http.NewRequest("GET", env.server.URL+"/api/v1/health", nil)
	req.Header.Set("Authorization", "Basic dXNlcjpwYXNz")
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 200 {
		t.Errorf("Basic auth header: %v %v", resp.StatusCode, err)
	}

	// Expired and revoked tokens stop working.
	conn := openTestDB(t, env.dbURL)
	var exp struct{ Token string }
	admin.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "Short", "expires_in_days": 1}, &exp)
	if _, err := conn.Exec(context.Background(), `update access_tokens set expires_at = now() - interval '1 second' where name = 'Short'`); err != nil {
		t.Fatal(err)
	}
	expired := env.client(t)
	expired.bearer = exp.Token
	expired.must(401, "GET", "/profile", nil, nil)
	admin.must(204, "DELETE", "/profile/access-tokens/"+created.ID, nil, nil)
	ci.must(401, "GET", "/profile", nil, nil)

	// Signing someone out everywhere stops their tokens too.
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "dana", "password": "dana-pass-1-secret", "require_password_change": false}, nil)
	dana := env.client(t)
	dana.signIn("dana", "dana-pass-1-secret")
	var dt struct{ Token string }
	dana.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "laptop", "expires_in_days": 7}, &dt)
	danaCI := env.client(t)
	danaCI.bearer = dt.Token
	danaCI.must(200, "GET", "/organizations", nil, nil)
	danaCI.must(403, "GET", "/admin/users", nil, nil) // not an instance admin
	var me struct{ ID string }
	dana.must(200, "GET", "/profile", nil, &me)
	admin.must(204, "DELETE", "/admin/users/"+me.ID+"/sessions", nil, nil)
	danaCI.must(401, "GET", "/organizations", nil, nil)

	// Disabling deletes tokens: enabling again doesn't bring them back.
	dana.signIn("dana", "dana-pass-1-secret")
	dana.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "laptop", "expires_in_days": 7}, &dt)
	admin.must(200, "PATCH", "/admin/users/"+me.ID, map[string]any{"disabled": true}, nil)
	admin.must(200, "PATCH", "/admin/users/"+me.ID, map[string]any{"disabled": false}, nil)
	danaCI.bearer = dt.Token
	danaCI.must(401, "GET", "/organizations", nil, nil)

	// So do changing your password and turning on two-factor sign-in.
	dana.signIn("dana", "dana-pass-1-secret")
	dana.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "laptop", "expires_in_days": 7}, &dt)
	danaCI.bearer = dt.Token
	danaCI.must(200, "GET", "/organizations", nil, nil)
	dana.must(204, "POST", "/profile/password", map[string]string{"current_password": "dana-pass-1-secret", "new_password": "dana-pass-2-secret"}, nil)
	danaCI.must(401, "GET", "/organizations", nil, nil)
	dana.must(200, "GET", "/profile", nil, nil) // this session stays
}
