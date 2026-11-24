package httpapi

import (
	"bytes"
	"context"
	"log/slog"
	"regexp"
	"testing"

	"supermixer/internal/auth"
	"supermixer/internal/bootstrap"
	"supermixer/internal/config"
	"supermixer/internal/store"
)

// With no bootstrap password configured, the first admin gets a one-time
// password, logged once, which must be changed at first sign-in.
func TestBootstrapGeneratesPassword(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, testDatabase(t), 0, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	var log bytes.Buffer
	if err := bootstrap.EnsureAdmin(ctx, st, &cfg, slog.New(slog.NewTextHandler(&log, nil))); err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`password=(\S+)`).FindStringSubmatch(log.String())
	if m == nil || len(m[1]) < 16 {
		t.Fatalf("no one-time password in the log: %s", log.String())
	}
	u, err := st.Queries.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !u.PasswordChangeRequired || u.DefaultPassword || !u.IsInstanceAdmin || auth.VerifyPassword(u.PasswordHash, m[1]) != nil {
		t.Fatalf("admin = %+v", u)
	}
	// Starting again doesn't make another, or log a password.
	log.Reset()
	if err := bootstrap.EnsureAdmin(ctx, st, &cfg, slog.New(slog.NewTextHandler(&log, nil))); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.Queries.CountUsers(ctx); n != 1 || bytes.Contains(log.Bytes(), []byte("password=")) {
		t.Fatalf("second start: %d users, log %s", n, log.String())
	}
}

func TestInstanceAdminConsole(t *testing.T) {
	env := newTestEnvWith(t, func(c *config.Config) { c.Provisioning.BackupsDir = "/backups" })
	admin := env.client(t)
	admin.signIn("admin", "admin")
	var created struct {
		ID                     string `json:"id"`
		PasswordChangeRequired bool   `json:"password_change_required"`
	}
	admin.must(400, "POST", "/admin/users", map[string]any{"username": "carol", "password": "carol"}, nil) // her own name
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "carol", "password": "carol-temp-1"}, &created)
	if !created.PasswordChangeRequired {
		t.Fatal("an admin-created account doesn't have to change its password")
	}
	carol := env.client(t)
	carol.signIn("carol", "carol-temp-1")
	carol.must(403, "GET", "/organizations", nil, nil)
	carol.must(204, "POST", "/profile/password", map[string]string{"current_password": "carol-temp-1", "new_password": "carols-own-1"}, nil)
	carol.must(200, "GET", "/organizations", nil, nil)
	carol.must(403, "GET", "/admin/overview", nil, nil)
	carol.must(403, "GET", "/admin/audit-logs", nil, nil)

	// An admin can require it again, and sign her out everywhere.
	admin.must(200, "PATCH", "/admin/users/"+created.ID, map[string]any{"password_change_required": true}, nil)
	carol.must(403, "GET", "/organizations", nil, nil)
	admin.must(204, "DELETE", "/admin/users/"+created.ID+"/sessions", nil, nil)
	carol.must(401, "GET", "/profile", nil, nil)
	// A reset password is temporary too, unless the admin says otherwise.
	admin.must(204, "POST", "/admin/users/"+created.ID+"/password", map[string]any{"password": "carol-temp-2", "require_password_change": false}, nil)
	carol.signIn("carol", "carol-temp-2")
	carol.must(200, "GET", "/organizations", nil, nil)

	var users []struct {
		Username string
		Sessions int
	}
	admin.must(200, "GET", "/admin/users", nil, &users)
	for _, u := range users {
		if u.Username == "carol" && u.Sessions != 1 {
			t.Errorf("carol's sessions = %d", u.Sessions)
		}
	}
	var overview struct {
		Users, Organizations, Projects int
		Backups                        struct{ Dir string }
	}
	admin.must(200, "GET", "/admin/overview", nil, &overview)
	if overview.Users != 2 || overview.Backups.Dir != "/backups" {
		t.Errorf("overview = %+v", overview)
	}
	var audit struct {
		Entries []struct{ Action, TargetName string } `json:"entries"`
	}
	admin.must(200, "GET", "/admin/audit-logs?action=user.", nil, &audit)
	seen := map[string]bool{}
	for _, e := range audit.Entries {
		seen[e.Action] = true
	}
	for _, want := range []string{"user.created", "user.password_changed", "user.updated", "user.signed_out_everywhere", "user.password_reset"} {
		if !seen[want] {
			t.Errorf("instance audit log lacks %s (%v)", want, seen)
		}
	}
}
