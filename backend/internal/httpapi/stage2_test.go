package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// recordingGateway answers everything with 200 and remembers the requests.
type recordingGateway struct {
	mu   sync.Mutex
	reqs []*http.Request
	body []string
}

func (g *recordingGateway) last() (*http.Request, string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.reqs[len(g.reqs)-1], g.body[len(g.body)-1]
}

func newRecordingGateway(t *testing.T) (*recordingGateway, string) {
	g := &recordingGateway{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		g.mu.Lock()
		g.reqs = append(g.reqs, r.Clone(r.Context()))
		g.body = append(g.body, string(b))
		g.mu.Unlock()
		w.Header().Set("Set-Cookie", "upstream=1")
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/reject-key") {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"msg":"invalid JWT"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return g, srv.URL
}

func TestGatewayProxy(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Gw"}, nil)
	gw, gwURL := newRecordingGateway(t)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/gw/projects", map[string]any{"name": "P", "connection": connectionFor(t, gwURL, env.dbURL)}, &p)
	base := "/projects/" + p.Ref + "/gateway/"

	t.Run("forwards with the admin key and strips our credentials", func(t *testing.T) {
		admin.must(200, "GET", base+"auth/v1/admin/users?page=2&per_page=5", nil, nil)
		r, _ := gw.last()
		if r.URL.Path != "/auth/v1/admin/users" || r.URL.RawQuery != "page=2&per_page=5" {
			t.Fatalf("upstream got %s", r.URL)
		}
		if r.Header.Get("apikey") != "service.jwt.key" || r.Header.Get("Authorization") != "Bearer service.jwt.key" {
			t.Fatalf("keys = %q %q", r.Header.Get("apikey"), r.Header.Get("Authorization"))
		}
		for _, h := range []string{"Cookie", csrfHeader, "Origin", "Referer"} {
			if v := r.Header.Get(h); v != "" {
				t.Fatalf("leaked %s: %q", h, v)
			}
		}
		if r.Host == "" || strings.Contains(r.Host, "supermixer") {
			t.Fatalf("host = %q", r.Host)
		}
	})

	t.Run("a stack rejecting our key is not a Supermixer sign-out", func(t *testing.T) {
		var body struct{ Msg string }
		admin.must(502, "GET", base+"auth/v1/admin/users/reject-key", nil, &body)
		if body.Msg != "invalid JWT" {
			t.Fatalf("body = %+v", body)
		}
		admin.must(200, "GET", "/profile", nil, nil) // still signed in
	})

	t.Run("keeps PostgREST's trailing slash and escapes names", func(t *testing.T) {
		admin.must(200, "GET", base+"rest/v1/", nil, nil)
		if r, _ := gw.last(); r.URL.Path != "/rest/v1/" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		admin.must(200, "GET", base+"storage/v1/object/avatars/my%20photo.png", nil, nil)
		if r, _ := gw.last(); r.URL.EscapedPath() != "/storage/v1/object/avatars/my%20photo.png" {
			t.Fatalf("path = %q", r.URL.EscapedPath())
		}
	})

	t.Run("passes bodies and audits changes", func(t *testing.T) {
		admin.must(200, "POST", base+"storage/v1/bucket", map[string]any{"name": "avatars", "public": false}, nil)
		r, body := gw.last()
		if r.Method != "POST" || !strings.Contains(body, `"avatars"`) {
			t.Fatalf("%s %q", r.Method, body)
		}
		var page struct{ Entries []struct{ Action string } }
		admin.must(200, "GET", "/organizations/gw/audit-logs?action=project.storage", nil, &page)
		if len(page.Entries) != 1 {
			t.Fatalf("audit = %+v", page.Entries)
		}
	})

	t.Run("listing files is a read: open to read-only members and not audited", func(t *testing.T) {
		auditCount := func() int {
			var page struct{ Entries []struct{ Action string } }
			admin.must(200, "GET", "/organizations/gw/audit-logs?action=project.storage", nil, &page)
			return len(page.Entries)
		}
		before := auditCount()
		reader := joinAs(t, env, admin, "gw", "gwreader", "read_only")
		reader.must(200, "POST", base+"storage/v1/object/list/avatars", map[string]any{"prefix": ""}, nil)
		if r, _ := gw.last(); r.Method != "POST" || r.URL.Path != "/storage/v1/object/list/avatars" {
			t.Fatalf("upstream got %s %s", r.Method, r.URL.Path)
		}
		admin.must(200, "POST", base+"storage/v1/object/list/avatars", map[string]any{"prefix": ""}, nil)
		if got := auditCount(); got != before {
			t.Fatalf("listing wrote %d audit entries", got-before)
		}
		// Uploads still need write access, and a bucket named "list" still downloads.
		reader.must(403, "POST", base+"storage/v1/object/avatars/x.png", map[string]any{}, nil)
		reader.must(200, "GET", base+"storage/v1/object/list/photo.png", nil, nil)
	})

	t.Run("Edge Functions need write access for every method and are audited", func(t *testing.T) {
		reader := joinAs(t, env, admin, "gw", "fnreader", "read_only")
		before := len(gw.reqs)
		reader.must(403, "GET", base+"functions/v1/hello", nil, nil)
		if len(gw.reqs) != before {
			t.Fatal("a read-only member reached a function")
		}
		admin.must(200, "GET", base+"functions/v1/hello?name=x", nil, nil)
		if r, _ := gw.last(); r.URL.Path != "/functions/v1/hello" || r.URL.RawQuery != "name=x" {
			t.Fatalf("upstream got %s", r.URL)
		}
		// Without the CSRF header, as a link on another site would send it.
		before = len(gw.reqs)
		req, _ := http.NewRequest("GET", env.server.URL+"/api/v1"+base+"functions/v1/hello", nil)
		resp, err := admin.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 || len(gw.reqs) != before {
			t.Fatalf("GET without the CSRF token = %d, reached the stack: %v", resp.StatusCode, len(gw.reqs) != before)
		}
		var page struct{ Entries []struct{ Action string } }
		admin.must(200, "GET", "/organizations/gw/audit-logs?action=project.function_invoked", nil, &page)
		if len(page.Entries) != 1 {
			t.Fatalf("audit = %+v", page.Entries)
		}
	})

	t.Run("the Realtime socket needs an upgrade and the CSRF token", func(t *testing.T) {
		upgrade := func(c *client, path string, withCSRF bool) int {
			t.Helper()
			u, _ := url.Parse(env.server.URL)
			q := ""
			for _, ck := range c.http.Jar.Cookies(u) {
				if ck.Name == csrfCookie && withCSRF {
					q = "&csrf=" + url.QueryEscape(ck.Value)
				}
			}
			req, _ := http.NewRequest("GET", env.server.URL+"/api/v1"+base+path+"?vsn=1.0.0"+q, nil)
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", "websocket")
			req.Header.Set("Sec-WebSocket-Version", "13")
			req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
			resp, err := c.http.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			return resp.StatusCode
		}
		before := len(gw.reqs)
		if got := upgrade(admin, "realtime/v1/websocket", false); got != 403 {
			t.Fatalf("without the token = %d", got)
		}
		if got := admin.do("GET", base+"realtime/v1/websocket", nil, nil); got != 400 {
			t.Fatalf("without an upgrade = %d", got)
		}
		if got := upgrade(admin, "storage/v1/bucket", true); got != 400 {
			t.Fatalf("upgrading another path = %d", got)
		}
		if len(gw.reqs) != before {
			t.Fatal("a refused socket reached the stack")
		}
		reader := joinAs(t, env, admin, "gw", "rtreader", "read_only")
		if got := upgrade(reader, "realtime/v1/websocket", true); got != 403 {
			t.Fatalf("read-only member = %d", got)
		}
		upgrade(admin, "realtime/v1/websocket", true)
		r, _ := gw.last()
		if r.URL.Path != "/realtime/v1/websocket" || r.URL.RawQuery != "vsn=1.0.0" || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			t.Fatalf("upstream got %s, Upgrade %q", r.URL, r.Header.Get("Upgrade"))
		}
		if r.Header.Get("apikey") != "service.jwt.key" {
			t.Fatal("no admin key on the socket")
		}
	})

	t.Run("refuses anything off the allowlist, however it is encoded", func(t *testing.T) {
		before := len(gw.reqs)
		for _, c := range []struct {
			method, path string
			want         int
		}{
			{"GET", "pg/tables", 404},
			{"GET", "auth/v1/admin/../../pg/tables", 400},
			{"POST", "storage/v1/object/%2e%2e/%2e%2e/%2e%2e/pg/query", 400},
			{"GET", "storage/v1/object/%2E%2E/%2E%2E/%2E%2E/pg/tables", 400},
			{"GET", "storage/v1/object/x/%2e/y", 400},
			{"GET", "storage/v1/object/a%2Fb", 400},
			{"GET", "storage/v1/object/a%5C..%5Cb", 400},
			{"GET", "storage/v1/object//pg/tables", 400},
			{"GET", "rest/v1/some_table", 404},
			{"GET", "auth/v1/token", 404},
			{"GET", "auth/v1/recover", 405},
			{"POST", "auth/v1/recover/x", 404},
			{"DELETE", "rest/v1/", 405},
			{"PATCH", "storage/v1/bucket/x", 405},
		} {
			if got := admin.do(c.method, base+c.path, nil, nil); got != c.want {
				t.Errorf("%s %s = %d, want %d", c.method, c.path, got, c.want)
			}
		}
		if len(gw.reqs) != before {
			t.Fatalf("%d refused requests reached the stack", len(gw.reqs)-before)
		}
	})

	t.Run("upstream cookies are dropped and files are sandboxed", func(t *testing.T) {
		req, _ := http.NewRequest("GET", env.server.URL+"/api/v1"+base+"storage/v1/bucket", nil)
		resp, err := admin.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.Header.Get("Set-Cookie") != "" || !strings.HasPrefix(resp.Header.Get("Content-Security-Policy"), "sandbox") {
			t.Fatalf("headers = %v", resp.Header)
		}
	})
}

// joinAs creates a user and adds them to org with role via an invitation.
func joinAs(t *testing.T, env *testEnv, admin *client, org, username, role string) *client {
	t.Helper()
	admin.must(201, "POST", "/admin/users", map[string]any{"username": username, "password": username + "-password"}, nil)
	var inv struct{ Token string }
	admin.must(201, "POST", "/organizations/"+org+"/invitations", map[string]any{"role": role}, &inv)
	c := env.client(t)
	c.signIn(username, username+"-password")
	c.must(200, "POST", "/invitations/"+inv.Token+"/accept", nil, nil)
	return c
}

func TestQueryAndSnippets(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Sql"}, nil)
	_, gwURL := newRecordingGateway(t)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/sql/projects", map[string]any{"name": "P", "connection": connectionFor(t, gwURL, env.dbURL)}, &p)
	q := "/projects/" + p.Ref + "/query"
	reader := joinAs(t, env, admin, "sql", "reader", "read_only")
	dev := joinAs(t, env, admin, "sql", "dev", "developer")

	type resp struct {
		ReadOnly bool `json:"read_only"`
		Results  []struct {
			Rows [][]any
		}
		Code string
	}
	var r resp
	admin.must(200, "POST", q, map[string]any{"query": "create table things (id int); insert into things values (1); select count(*)::int from things"}, &r)
	if r.ReadOnly || len(r.Results) != 3 || r.Results[2].Rows[0][0] != float64(1) {
		t.Fatalf("admin run = %+v", r)
	}

	t.Run("read-only members cannot write", func(t *testing.T) {
		var out resp
		reader.must(200, "POST", q, map[string]any{"query": "select count(*)::int from things"}, &out)
		if !out.ReadOnly {
			t.Fatal("reader's query was not read-only")
		}
		if got := reader.do("POST", q, map[string]any{"query": "drop table things"}, &out); got != 422 || out.Code != "25006" {
			t.Fatalf("drop = %d %+v", got, out)
		}
		if got := reader.do("POST", q, map[string]any{"query": "commit; drop table things"}, nil); got != 422 {
			t.Fatalf("smuggled drop = %d", got)
		}
		admin.must(200, "POST", q, map[string]any{"query": "select 1 from things"}, nil)
	})

	t.Run("limits from the spec are enforced", func(t *testing.T) {
		for _, n := range []int{0, 10001, 2000000000} {
			if got := admin.do("POST", q, map[string]any{"query": "select 1", "max_rows": n}, nil); got != 400 {
				t.Errorf("max_rows %d = %d, want 400", n, got)
			}
		}
		var out resp
		admin.must(200, "POST", q, map[string]any{"query": "select generate_series(1, 5)", "max_rows": 2}, &out)
		if len(out.Results[0].Rows) != 2 {
			t.Errorf("max_rows 2 returned %d rows", len(out.Results[0].Rows))
		}
		s := "/projects/" + p.Ref + "/snippets"
		if got := admin.do("POST", s, map[string]any{"name": "x", "content": "", "visibility": "public"}, nil); got != 400 {
			t.Errorf("visibility public = %d, want 400", got)
		}
	})

	t.Run("snippets: private stays private, shared is visible but not editable", func(t *testing.T) {
		s := "/projects/" + p.Ref + "/snippets"
		var mine, shared struct {
			ID      string `json:"id"`
			CanEdit bool   `json:"can_edit"`
		}
		dev.must(201, "POST", s, map[string]any{"name": "Mine", "content": "select 1"}, &mine)
		dev.must(201, "POST", s, map[string]any{"name": "Shared", "content": "select 2", "visibility": "project"}, &shared)
		var list []struct{ Name string }
		reader.must(200, "GET", s, nil, &list)
		if len(list) != 1 || list[0].Name != "Shared" {
			t.Fatalf("reader sees %+v", list)
		}
		if got := reader.do("GET", s+"/"+mine.ID, nil, nil); got != 404 {
			t.Fatalf("reader read a private snippet: %d", got)
		}
		if got := reader.do("PATCH", s+"/"+shared.ID, map[string]any{"content": "drop table x"}, nil); got != 403 {
			t.Fatalf("reader edited a shared snippet: %d", got)
		}
		var fav struct{ Favorite bool }
		reader.must(200, "PATCH", s+"/"+shared.ID, map[string]any{"favorite": true}, &fav)
		if !fav.Favorite {
			t.Fatal("favorite not set")
		}
		if got := reader.do("DELETE", s+"/"+shared.ID, nil, nil); got != 403 {
			t.Fatalf("reader deleted a shared snippet: %d", got)
		}
		admin.must(204, "DELETE", s+"/"+shared.ID, nil, nil) // project admins can tidy up
		dev.must(204, "DELETE", s+"/"+mine.ID, nil, nil)
	})
}

func TestReadOnlyLogin(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Ro"}, nil)
	_, gwURL := newRecordingGateway(t)
	var p struct {
		Ref      string
		Database struct {
			User         string  `json:"user"`
			ReadOnlyUser *string `json:"read_only_user"`
		}
	}
	admin.must(201, "POST", "/organizations/ro/projects", map[string]any{"name": "P", "connection": connectionFor(t, gwURL, env.dbURL)}, &p)
	reader := joinAs(t, env, admin, "ro", "reader", "read_only")
	q := "/projects/" + p.Ref + "/query"
	who := func(c *client) string {
		var out struct{ Results []struct{ Rows [][]any } }
		c.must(200, "POST", q, map[string]any{"query": "select current_user::text"}, &out)
		return out.Results[0].Rows[0][0].(string)
	}
	adminUser := who(reader)

	if got := reader.do("POST", "/projects/"+p.Ref+"/read-only-user", nil, nil); got != 403 {
		t.Fatalf("a Read-only member created the login: %d", got)
	}
	admin.must(200, "POST", "/projects/"+p.Ref+"/read-only-user", nil, &p)
	if p.Database.ReadOnlyUser == nil || !strings.HasPrefix(*p.Database.ReadOnlyUser, "supermixer_ro_") {
		t.Fatalf("project = %+v", p)
	}
	t.Cleanup(func() { admin.do("DELETE", "/projects/"+p.Ref+"/read-only-user", nil, nil) })

	if got := who(reader); got != *p.Database.ReadOnlyUser {
		t.Fatalf("reader runs as %q, want %q", got, *p.Database.ReadOnlyUser)
	}
	if got := who(admin); got != adminUser {
		t.Fatalf("admin runs as %q, want %q", got, adminUser)
	}
	admin.must(200, "POST", q, map[string]any{"query": "create table ro_visible (id int); insert into ro_visible values (7)"}, nil)
	var rows struct{ Results []struct{ Rows [][]any } }
	reader.must(200, "POST", q, map[string]any{"query": "select id from ro_visible"}, &rows)
	if rows.Results[0].Rows[0][0] != float64(7) {
		t.Fatalf("the read-only login cannot read tables: %+v", rows)
	}
	var qe struct{ Code string }
	if got := reader.do("POST", q, map[string]any{"query": "select set_config('role', '" + adminUser + "', false)"}, &qe); got != 422 || qe.Code != "42501" {
		t.Fatalf("switching back to the admin role = %d %+v", got, qe)
	}
	if got := admin.do("POST", "/projects/"+p.Ref+"/read-only-user", nil, nil); got != 409 {
		t.Fatalf("second create = %d", got)
	}

	admin.must(200, "DELETE", "/projects/"+p.Ref+"/read-only-user", nil, &p)
	if p.Database.ReadOnlyUser != nil || who(reader) != adminUser {
		t.Fatalf("after removal: %+v, reader runs as %s", p, who(reader))
	}
}
