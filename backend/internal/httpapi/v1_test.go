package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// v1 calls the Supabase-style Management API with a token.
func v1(t *testing.T, env *testEnv, token, method, path string, body, out any) int {
	t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, env.server.URL+"/v1"+path, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("%s %s: %s", method, path, raw)
		}
	}
	return resp.StatusCode
}

func TestManagementAPI(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Tools"}, nil)
	_, gwURL := newRecordingGateway(t)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/tools/projects", map[string]any{"name": "Main", "connection": connectionFor(t, gwURL, env.dbURL)}, &p)
	var tok struct{ Token string }
	admin.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "cli", "expires_in_days": 7}, &tok)

	// Tokens only: no session, no anonymous use.
	if got := v1(t, env, "", "GET", "/organizations", nil, nil); got != 401 {
		t.Fatalf("anonymous = %d", got)
	}
	var orgs []struct{ ID, Name string }
	if got := v1(t, env, tok.Token, "GET", "/organizations", nil, &orgs); got != 200 || len(orgs) != 1 || orgs[0].ID != "tools" {
		t.Fatalf("organizations = %d %+v", got, orgs)
	}
	var projects []struct {
		ID, Ref, Name, Status string
		OrganizationID        string `json:"organization_id"`
	}
	if got := v1(t, env, tok.Token, "GET", "/projects", nil, &projects); got != 200 || len(projects) != 1 ||
		projects[0].Ref != p.Ref || projects[0].ID != p.Ref || projects[0].OrganizationID != "tools" || projects[0].Status != "ACTIVE_HEALTHY" {
		t.Fatalf("projects = %d %+v", got, projects)
	}
	var rows []map[string]any
	if got := v1(t, env, tok.Token, "POST", "/projects/"+p.Ref+"/database/query", map[string]string{"query": "select 1 as one, 'x' as two"}, &rows); got != 201 ||
		len(rows) != 1 || rows[0]["one"] != float64(1) || rows[0]["two"] != "x" {
		t.Fatalf("query = %d %+v", got, rows)
	}
	var keys []struct {
		Name   string
		APIKey *string `json:"api_key"`
		Type   string
	}
	if got := v1(t, env, tok.Token, "GET", "/projects/"+p.Ref+"/api-keys", nil, &keys); got != 200 || len(keys) < 2 {
		t.Fatalf("api keys = %d %+v", got, keys)
	}
	for _, k := range keys {
		if k.Type != "legacy" || k.APIKey == nil {
			t.Errorf("key %+v", k)
		}
	}
	var members []struct {
		UserName string `json:"user_name"`
		RoleName string `json:"role_name"`
	}
	if got := v1(t, env, tok.Token, "GET", "/organizations/tools/members", nil, &members); got != 200 || members[0].RoleName != "Owner" {
		t.Fatalf("members = %d %+v", got, members)
	}

	// The same permissions as in the app: a Read-only member's token can't
	// see secret keys, or write.
	ro := joinAs(t, env, admin, "tools", "rita", "read_only")
	var roTok struct{ Token string }
	ro.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "ro", "expires_in_days": 7}, &roTok)
	keys = nil
	v1(t, env, roTok.Token, "GET", "/projects/"+p.Ref+"/api-keys", nil, &keys)
	for _, k := range keys {
		if k.Name == "service_role" && k.APIKey != nil {
			t.Error("a Read-only member's token got the service_role key")
		}
	}
	var e struct{ Message string }
	if got := v1(t, env, roTok.Token, "POST", "/projects/"+p.Ref+"/database/query", map[string]string{"query": "create table nope (id int)"}, &e); got < 400 {
		t.Fatalf("read-only write = %d", got)
	}
	if got := v1(t, env, tok.Token, "GET", "/projects/"+p.Ref+"/nonsense", nil, &e); got != 404 {
		t.Fatalf("unknown path = %d", got)
	}
	// A browser session on /v1 is told to use a token, not about CSRF.
	if got := admin.doURL("POST", "/v1/projects/"+p.Ref+"/pause", &e); got != 401 || !strings.Contains(e.Message, "access token") {
		t.Fatalf("session on /v1 = %d %q", got, e.Message)
	}
	// Tokens go through the project gateway too, without a CSRF token.
	gw := env.client(t)
	gw.bearer = tok.Token
	if got := gw.do("GET", "/projects/"+p.Ref+"/gateway/functions/v1/hello", nil, nil); got == 403 {
		t.Fatal("a token was refused by the gateway's CSRF check")
	}
}

// doURL sends a request outside /api/v1 with the client's cookies (and CSRF
// header, if it has one).
func (c *client) doURL(method, path string, out any) int {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.env.server.URL+path, nil)
	u, _ := url.Parse(c.env.server.URL)
	for _, ck := range c.http.Jar.Cookies(u) {
		if ck.Name == csrfCookie {
			req.Header.Set(csrfHeader, ck.Value)
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil {
		_ = json.Unmarshal(raw, out)
	}
	return resp.StatusCode
}
