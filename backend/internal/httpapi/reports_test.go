package httpapi

import (
	"context"
	"encoding/json"
	"testing"
)

// Instance › Organizations and Projects list every one, for reports, but
// give an instance admin no way into an organization they aren't in.
func TestInstanceReports(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "dana", "password": "dana-long-password", "require_password_change": false}, nil)
	dana := env.client(t)
	dana.signIn("dana", "dana-long-password")
	dana.must(201, "POST", "/organizations", map[string]string{"name": "Dana Co"}, nil)
	var p struct{ Ref, ID string }
	dana.must(201, "POST", "/organizations/dana-co/projects", map[string]any{"name": "Shop", "connection": connectionFor(t, fakeGateway(t), env.dbURL)}, &p)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Empty"}, nil)

	conn := openTestDB(t, env.dbURL)
	if _, err := conn.Exec(context.Background(), `insert into backups (project_id, kind, status, size_bytes, template, started_at, finished_at) values
		($1, 'scheduled', 'completed', 1000, 't', now() - interval '2 hours', now() - interval '2 hours'),
		($1, 'scheduled', 'failed', 0, 't', now() - interval '1 hour', now() - interval '1 hour')`, p.ID); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/admin/organizations", "/admin/projects"} {
		dana.must(403, "GET", path, nil, nil)
	}

	var orgs []struct {
		Slug           string
		Owners         []string
		Members        int
		Projects       int
		CreatedBy      *string `json:"created_by"`
		LastActivityAt *string `json:"last_activity_at"`
		ProjectLimit   *int    `json:"project_limit"`
	}
	admin.must(200, "GET", "/admin/organizations", nil, &orgs)
	bySlug := map[string]int{}
	for i, o := range orgs {
		bySlug[o.Slug] = i
	}
	d, ok := bySlug["dana-co"]
	if !ok {
		t.Fatalf("Dana Co isn't listed: %+v", orgs)
	}
	if o := orgs[d]; len(o.Owners) != 1 || o.Owners[0] != "dana" || o.Members != 1 || o.Projects != 1 ||
		o.CreatedBy == nil || *o.CreatedBy != "dana" || o.LastActivityAt == nil {
		t.Errorf("Dana Co = %+v", o)
	}
	if o := orgs[bySlug["empty"]]; o.Projects != 0 || o.ProjectLimit != nil {
		t.Errorf("Empty = %+v", o)
	}

	// A provider removed from the config isn't enforced, and a disabled
	// owner can't act as one: both show.
	if _, err := conn.Exec(context.Background(), `update organizations set sso_provider = 'gone', sso_required = true where slug = 'dana-co'`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(context.Background(), `update users set disabled_at = now() where username = 'dana'`); err != nil {
		t.Fatal(err)
	}
	var again []struct {
		Slug               string
		Owners             []string
		SsoProvider        *string `json:"sso_provider"`
		SsoProviderMissing bool    `json:"sso_provider_missing"`
	}
	admin.must(200, "GET", "/admin/organizations", nil, &again)
	for _, o := range again {
		if o.Slug == "dana-co" && (len(o.Owners) != 0 || o.SsoProvider == nil || !o.SsoProviderMissing) {
			t.Errorf("Dana Co after the changes = %+v", o)
		}
	}

	var raw []map[string]json.RawMessage
	admin.must(200, "GET", "/admin/projects", nil, &raw)
	if len(raw) != 1 {
		t.Fatalf("projects = %d", len(raw))
	}
	// Nothing to reach or sign in to the project with.
	for _, k := range []string{"api_url", "studio_url", "database", "keys_present", "secrets"} {
		if _, ok := raw[0][k]; ok {
			t.Errorf("a project's %s is listed", k)
		}
	}
	var projects []struct {
		Ref              string
		OrganizationSlug string `json:"organization_slug"`
		Managed          bool
		Status           *string
		Backups          int
		BackupBytes      int64                    `json:"backup_bytes"`
		LastBackup       *struct{ Status string } `json:"last_backup"`
		LastCompleted    *string                  `json:"last_completed_backup_at"`
	}
	admin.must(200, "GET", "/admin/projects", nil, &projects)
	if pr := projects[0]; pr.OrganizationSlug != "dana-co" || pr.Managed || pr.Status != nil || pr.Backups != 1 ||
		pr.BackupBytes != 1000 || pr.LastBackup == nil || pr.LastBackup.Status != "failed" || pr.LastCompleted == nil {
		t.Errorf("project = %+v", pr)
	}

	// Listing them isn't access to them.
	admin.must(404, "GET", "/organizations/dana-co", nil, nil)
	admin.must(404, "GET", "/projects/"+p.Ref, nil, nil)
}
