package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/bootstrap"
	"supermixer/internal/config"
	"supermixer/internal/provision"
	"supermixer/internal/secrets"
	"supermixer/internal/store"
	"supermixer/internal/theme"
)

const testKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="

// testDatabase creates a throwaway database on the server named by
// SUPERMIXER_TEST_DATABASE_URL (default: the dev compose Postgres). The test
// is skipped when no server is reachable.
func testDatabase(t *testing.T) string {
	t.Helper()
	admin := os.Getenv("SUPERMIXER_TEST_DATABASE_URL")
	if admin == "" {
		admin = "postgres://supermixer:supermixer@localhost:5433/supermixer?sslmode=disable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Skipf("no test Postgres (%v); run `make db` or set SUPERMIXER_TEST_DATABASE_URL", err)
	}
	name := fmt.Sprintf("sm_test_%d", time.Now().UnixNano())
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	conn.Close(ctx)
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), admin)
		if err == nil {
			_, _ = c.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)")
			c.Close(context.Background())
		}
	})
	u, _ := url.Parse(admin)
	u.Path = "/" + name
	return u.String()
}

type testEnv struct {
	server *httptest.Server
	dbURL  string
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	return newTestEnvWith(t, nil)
}

// newTestEnvWith lets a test change the configuration first.
func newTestEnvWith(t *testing.T, configure func(*config.Config)) *testEnv {
	t.Helper()
	return newTestEnvOn(t, testDatabase(t), configure)
}

// newTestEnvSharing starts another server on env's database, as if
// Supermixer had restarted.
func newTestEnvSharing(t *testing.T, env *testEnv, configure func(*config.Config)) *testEnv {
	t.Helper()
	return newTestEnvOn(t, env.dbURL, configure)
}

// openTestDB connects straight to a test database.
func openTestDB(t *testing.T, dbURL string) *pgx.Conn {
	t.Helper()
	c, err := pgx.Connect(context.Background(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(context.Background()) })
	return c
}

func newTestEnvOn(t *testing.T, dbURL string, configure func(*config.Config)) *testEnv {
	t.Helper()
	return newTestEnvDeps(t, dbURL, configure, nil)
}

// newTestEnvDeps lets a test change the server's collaborators too.
func newTestEnvDeps(t *testing.T, dbURL string, configure func(*config.Config), withDeps func(*Deps)) *testEnv {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := context.Background()
	st, err := store.Open(ctx, dbURL, 0, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	def := config.Default()
	cfg := &def
	cfg.Server.PublicURL = "http://supermixer.test"
	cfg.Security.EncryptionKey = testKey
	cfg.Security.SessionTTL = time.Hour
	cfg.BootstrapAdmin.Password = "admin" // tests sign in as admin/admin
	if configure != nil {
		configure(cfg)
	}
	if err := bootstrap.EnsureAdmin(ctx, st, cfg, logger); err != nil {
		t.Fatal(err)
	}
	// Tests sign in as admin/admin and get on with it; admin_test.go
	// covers the required change.
	if _, err := st.Pool.Exec(ctx, `update users set password_change_required = false where username = 'admin'`); err != nil {
		t.Fatal(err)
	}
	box, _ := secrets.New(testKey)
	palette, _ := theme.Derive("#0019A8")
	deps := Deps{Config: cfg, DB: st, Store: st, Box: box, Palette: palette, Logger: logger}
	if withDeps != nil {
		withDeps(&deps)
	}
	srv := httptest.NewServer(New(deps))
	t.Cleanup(srv.Close)
	return &testEnv{server: srv, dbURL: dbURL}
}

// client is a browser-like API client: it keeps cookies and sends the CSRF header.
type client struct {
	t    *testing.T
	env  *testEnv
	http *http.Client
	// bearer, if set, is sent as Authorization: Bearer (an access token).
	bearer string
}

func (e *testEnv) client(t *testing.T) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, env: e, http: &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any, out any) int {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, c.env.server.URL+"/api/v1"+path, r)
	req.Header.Set("Content-Type", "application/json")
	if c.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
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
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			c.t.Fatalf("%s %s: decoding %q: %v", method, path, raw, err)
		}
	}
	return resp.StatusCode
}

func (c *client) must(want int, method, path string, body any, out any) {
	c.t.Helper()
	var raw json.RawMessage
	got := c.do(method, path, body, &raw)
	if got != want {
		c.t.Fatalf("%s %s = %d, want %d: %s", method, path, got, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			c.t.Fatal(err)
		}
	}
}

func (c *client) signIn(username, password string) {
	c.t.Helper()
	c.must(200, "POST", "/auth/sign-in", map[string]string{"username": username, "password": password}, nil)
}

// fakeGateway answers every Supabase health route with 200.
func fakeGateway(t *testing.T) string {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/v1/health" {
			_, _ = w.Write([]byte(`{"version":"v2.test"}`))
			return
		}
		w.WriteHeader(200)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func connectionFor(t *testing.T, gateway, dbURL string) map[string]any {
	u, _ := url.Parse(dbURL)
	port, _ := strconv.Atoi(u.Port())
	pw, _ := u.User.Password()
	return map[string]any{
		"api_url": gateway,
		"database": map[string]any{
			"host": u.Hostname(), "port": port, "name": strings.TrimPrefix(u.Path, "/"),
			"user": u.User.Username(), "password": pw, "sslmode": "disable",
		},
		"keys": map[string]any{"anon": "anon.jwt.key", "service_role": "service.jwt.key", "jwt_secret": "s3cret"},
	}
}

func TestAuthAndCSRF(t *testing.T) {
	env := newTestEnv(t)
	c := env.client(t)

	if got := c.do("GET", "/organizations", nil, nil); got != 401 {
		t.Fatalf("unauthenticated = %d, want 401", got)
	}
	if got := c.do("POST", "/auth/sign-in", map[string]string{"username": "admin", "password": "nope"}, nil); got != 401 {
		t.Fatalf("wrong password = %d", got)
	}
	var me struct {
		DefaultPassword bool `json:"default_password"`
		IsInstanceAdmin bool `json:"is_instance_admin"`
	}
	c.must(200, "POST", "/auth/sign-in", map[string]string{"username": "ADMIN", "password": "admin"}, &me)
	if !me.DefaultPassword || !me.IsInstanceAdmin {
		t.Fatalf("bootstrap admin profile: %+v", me)
	}

	// A state-changing request without the CSRF header is rejected.
	req, _ := http.NewRequest("POST", env.server.URL+"/api/v1/organizations", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("missing CSRF = %d, want 403", resp.StatusCode)
	}

	// Changing the default password clears the flag.
	c.must(400, "POST", "/profile/password", map[string]string{"current_password": "admin", "new_password": "short"}, nil)
	c.must(204, "POST", "/profile/password", map[string]string{"current_password": "admin", "new_password": "a-much-better-password"}, nil)
	c.must(200, "GET", "/profile", nil, &me)
	if me.DefaultPassword {
		t.Fatal("default_password still set after change")
	}

	c.must(204, "POST", "/auth/sign-out", nil, nil)
	if got := c.do("GET", "/profile", nil, nil); got != 401 {
		t.Fatalf("after sign-out = %d", got)
	}
}

func TestSignInRateLimit(t *testing.T) {
	env := newTestEnv(t)
	c := env.client(t)
	for range 10 {
		c.do("POST", "/auth/sign-in", map[string]string{"username": "admin", "password": "wrong"}, nil)
	}
	if got := c.do("POST", "/auth/sign-in", map[string]string{"username": "admin", "password": "admin"}, nil); got != 429 {
		t.Fatalf("after 10 failures = %d, want 429", got)
	}
}

func TestOrganizationsRolesAndProjects(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")

	var org struct {
		Slug        string   `json:"slug"`
		Role        string   `json:"role"`
		Permissions []string `json:"permissions"`
	}
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Acme Inc."}, &org)
	if org.Slug != "acme-inc" || org.Role != "owner" {
		t.Fatalf("org = %+v", org)
	}
	var dup struct{ Slug string }
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Acme Inc"}, &dup)
	if dup.Slug != "acme-inc-2" {
		t.Fatalf("second slug = %q", dup.Slug)
	}

	// Register two projects against a fake gateway and the test database.
	gw := fakeGateway(t)
	var health struct {
		Status   string `json:"status"`
		Services []struct {
			Service, Status string
			Detail          string
		} `json:"services"`
		ExampleSecrets []string `json:"example_secrets"`
	}
	admin.must(200, "POST", "/organizations/acme-inc/projects/test-connection", connectionFor(t, gw, env.dbURL), &health)
	if health.Status != "healthy" || health.ExampleSecrets != nil {
		t.Fatalf("test-connection: %+v", health)
	}
	// Supabase's public example secrets are pointed out.
	example := connectionFor(t, gw, env.dbURL)
	example["keys"].(map[string]any)["jwt_secret"] = provision.ExampleEnv()["JWT_SECRET"]
	example["keys"].(map[string]any)["service_role"] = provision.ExampleEnv()["SERVICE_ROLE_KEY"]
	admin.must(200, "POST", "/organizations/acme-inc/projects/test-connection", example, &health)
	if !slices.Equal(health.ExampleSecrets, []string{"JWT secret", "service_role key"}) {
		t.Fatalf("example secrets = %v", health.ExampleSecrets)
	}
	var p1, p2 struct {
		Ref      string `json:"ref"`
		Database struct {
			URI string `json:"uri"`
		} `json:"database"`
	}
	admin.must(201, "POST", "/organizations/acme-inc/projects", map[string]any{"name": "Prod", "connection": connectionFor(t, gw, env.dbURL)}, &p1)
	admin.must(201, "POST", "/organizations/acme-inc/projects", map[string]any{"name": "Staging", "connection": connectionFor(t, gw, env.dbURL)}, &p2)
	if len(p1.Ref) != 20 || !strings.Contains(p1.Database.URI, "[YOUR-PASSWORD]") {
		t.Fatalf("project = %+v", p1)
	}

	// Developer joins through an invitation link.
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "dev1", "password": "dev-password-1"}, nil)
	var inv struct {
		Token string `json:"token"`
		URL   string `json:"url"`
	}
	admin.must(201, "POST", "/organizations/acme-inc/invitations", map[string]any{"role": "developer"}, &inv)
	if !strings.HasPrefix(inv.URL, "http://supermixer.test/join?token=") {
		t.Fatalf("invite url %q", inv.URL)
	}
	dev := env.client(t)
	dev.signIn("dev1", "dev-password-1")
	// The admin set this password: dev1 chooses their own before anything else.
	var me struct {
		PasswordChangeRequired bool `json:"password_change_required"`
	}
	dev.must(200, "GET", "/profile", nil, &me)
	if !me.PasswordChangeRequired {
		t.Fatal("an admin-set password didn't need changing")
	}
	dev.must(403, "GET", "/organizations", nil, nil)
	dev.must(400, "POST", "/profile/password", map[string]string{"current_password": "dev-password-1", "new_password": "password123"}, nil)
	dev.must(204, "POST", "/profile/password", map[string]string{"current_password": "dev-password-1", "new_password": "dev1-own-choice"}, nil)
	dev.must(200, "GET", "/profile", nil, &me)
	if me.PasswordChangeRequired {
		t.Fatal("still required after changing it")
	}
	var preview struct {
		OrganizationName string `json:"organization_name"`
		Valid            bool   `json:"valid"`
	}
	dev.must(200, "GET", "/invitations/"+inv.Token, nil, &preview)
	if !preview.Valid || preview.OrganizationName != "Acme Inc." {
		t.Fatalf("preview %+v", preview)
	}
	dev.must(200, "POST", "/invitations/"+inv.Token+"/accept", nil, nil)
	if got := dev.do("POST", "/invitations/"+inv.Token+"/accept", nil, nil); got != 409 && got != 410 {
		t.Fatalf("re-accept = %d", got)
	}

	// Developers can read secrets and data but not manage the org.
	if got := dev.do("POST", "/organizations/acme-inc/invitations", map[string]any{"role": "read_only"}, nil); got != 403 {
		t.Fatalf("developer invite = %d, want 403", got)
	}
	if got := dev.do("PATCH", "/projects/"+p1.Ref, map[string]any{"name": "x"}, nil); got != 403 {
		t.Fatalf("developer rename = %d, want 403", got)
	}
	var keys []struct {
		ID    string  `json:"id"`
		Value *string `json:"value"`
	}
	dev.must(200, "GET", "/projects/"+p1.Ref+"/api-keys?reveal=true", nil, &keys)
	if valueOf(keys, "service_role") != "service.jwt.key" {
		t.Fatalf("developer reveal: %+v", keys)
	}

	// Read-only member signs up through an invitation: cannot reveal secrets.
	var roInv struct{ Token string }
	admin.must(201, "POST", "/organizations/acme-inc/invitations", map[string]any{"role": "read_only", "email": "viewer@example.com"}, &roInv)
	viewer := env.client(t)
	viewer.must(201, "POST", "/invitations/"+roInv.Token+"/sign-up", map[string]any{"username": "viewer", "password": "viewer-password"}, nil)
	keys = nil
	viewer.must(200, "GET", "/projects/"+p1.Ref+"/api-keys", nil, &keys)
	if valueOf(keys, "anon") != "anon.jwt.key" || valueOf(keys, "service_role") != "" {
		t.Fatalf("read-only keys: %+v", keys)
	}
	if got := viewer.do("GET", "/projects/"+p1.Ref+"/api-keys?reveal=true", nil, nil); got != 403 {
		t.Fatalf("read-only reveal = %d, want 403", got)
	}

	// A project-scoped member sees only the project they were given.
	var scopedInv struct{ Token string }
	admin.must(201, "POST", "/organizations/acme-inc/invitations", map[string]any{
		"role": "no_access", "project_roles": []map[string]string{{"ref": p2.Ref, "role": "developer"}},
	}, &scopedInv)
	scoped := env.client(t)
	scoped.must(201, "POST", "/invitations/"+scopedInv.Token+"/sign-up", map[string]any{"username": "contractor", "password": "contractor-pw"}, nil)
	var visible []struct{ Ref string }
	scoped.must(200, "GET", "/projects", nil, &visible)
	if len(visible) != 1 || visible[0].Ref != p2.Ref {
		t.Fatalf("scoped member sees %+v, want only %s", visible, p2.Ref)
	}
	if got := scoped.do("GET", "/projects/"+p1.Ref, nil, nil); got != 404 {
		t.Fatalf("scoped member on other project = %d, want 404", got)
	}
	if got := scoped.do("GET", "/organizations/acme-inc/members", nil, nil); got != 403 {
		t.Fatalf("no_access member list = %d, want 403", got)
	}

	// Outsiders cannot see the organization at all.
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "outsider", "password": "outsider-pw", "require_password_change": false}, nil)
	out := env.client(t)
	out.signIn("outsider", "outsider-pw")
	if got := out.do("GET", "/organizations/acme-inc", nil, nil); got != 404 {
		t.Fatalf("outsider = %d, want 404", got)
	}

	// The last Owner cannot be removed or demoted.
	var members []struct {
		UserID   string `json:"user_id"`
		Username string `json:"username"`
	}
	admin.must(200, "GET", "/organizations/acme-inc/members", nil, &members)
	adminID := ""
	for _, m := range members {
		if m.Username == "admin" {
			adminID = m.UserID
		}
	}
	if got := admin.do("PATCH", "/organizations/acme-inc/members/"+adminID, map[string]any{"role": "developer"}, nil); got != 409 {
		t.Fatalf("demote last owner = %d, want 409", got)
	}
	if got := admin.do("DELETE", "/organizations/acme-inc/members/"+adminID, nil, nil); got != 409 {
		t.Fatalf("remove last owner = %d, want 409", got)
	}

	// Organizations with projects cannot be deleted.
	if got := admin.do("DELETE", "/organizations/acme-inc", nil, nil); got != 409 {
		t.Fatalf("delete org with projects = %d, want 409", got)
	}

	// Transfer, then delete, then the audit log tells the story.
	admin.must(200, "POST", "/projects/"+p2.Ref+"/transfer", map[string]string{"organization_slug": "acme-inc-2"}, nil)
	admin.must(204, "DELETE", "/projects/"+p1.Ref, nil, nil)
	var page struct {
		Entries []struct{ Action string } `json:"entries"`
	}
	admin.must(200, "GET", "/organizations/acme-inc/audit-logs", nil, &page)
	actions := map[string]bool{}
	for _, e := range page.Entries {
		actions[e.Action] = true
	}
	for _, want := range []string{"organization.created", "project.created", "invitation.created", "member.joined", "project.secrets_revealed", "project.transferred_out", "project.deleted"} {
		if !actions[want] {
			t.Errorf("audit log missing %s (have %v)", want, actions)
		}
	}
	if got := dev.do("GET", "/organizations/acme-inc/audit-logs", nil, nil); got != 403 {
		t.Errorf("developer audit = %d, want 403", got)
	}
}

func TestInstanceAdminGuards(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")
	var me struct{ ID string }
	admin.must(200, "GET", "/profile", nil, &me)
	if got := admin.do("PATCH", "/admin/users/"+me.ID, map[string]any{"disabled": true}, nil); got != 400 {
		t.Fatalf("disable self = %d, want 400", got)
	}
	var u struct{ ID string }
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "bob", "password": "bob-password", "require_password_change": false}, &u)
	bob := env.client(t)
	bob.signIn("bob", "bob-password")
	if got := bob.do("GET", "/admin/users", nil, nil); got != 403 {
		t.Fatalf("non-admin list users = %d", got)
	}
	admin.must(200, "PATCH", "/admin/users/"+u.ID, map[string]any{"disabled": true}, nil)
	if got := bob.do("GET", "/profile", nil, nil); got != 401 {
		t.Fatalf("disabled user session still works: %d", got)
	}
	if got := admin.do("POST", "/admin/users", map[string]any{"username": "bob", "password": "another-pw"}, nil); got != 409 {
		t.Fatalf("duplicate username = %d", got)
	}
}

func valueOf(keys []struct {
	ID    string  `json:"id"`
	Value *string `json:"value"`
}, id string) string {
	for _, k := range keys {
		if k.ID == id && k.Value != nil {
			return *k.Value
		}
	}
	return ""
}

func TestProfileTheme(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")

	var p struct {
		DisplayName string  `json:"display_name"`
		Theme       *string `json:"theme"`
	}
	admin.must(200, "GET", "/profile", nil, &p)
	if p.Theme != nil {
		t.Fatalf("a new user has theme %q; want none, so the default applies", *p.Theme)
	}
	name := p.DisplayName

	admin.must(200, "PATCH", "/profile", map[string]any{"theme": "dark"}, &p)
	if p.Theme == nil || *p.Theme != "dark" || p.DisplayName != name {
		t.Fatalf("after saving dark: %+v", p)
	}
	admin.must(200, "GET", "/profile", nil, &p)
	if p.Theme == nil || *p.Theme != "dark" {
		t.Fatalf("theme wasn't kept: %+v", p)
	}
	admin.must(400, "PATCH", "/profile", map[string]any{"theme": "sepia"}, nil)

	// Updating the name leaves the theme alone.
	admin.must(200, "PATCH", "/profile", map[string]any{"display_name": "Ada"}, &p)
	if p.Theme == nil || *p.Theme != "dark" || p.DisplayName != "Ada" {
		t.Fatalf("after renaming: %+v", p)
	}
}
