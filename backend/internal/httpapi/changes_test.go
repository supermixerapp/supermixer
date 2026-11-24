package httpapi

import (
	"testing"
)

// A snapshot of a connected project's database, then what changed since.
func TestDBChanges(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Chg"}, nil)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/chg/projects", map[string]any{"name": "P", "connection": connectionFor(t, fakeGateway(t), env.dbURL)}, &p)
	base := "/projects/" + p.Ref + "/advisors"

	admin.must(404, "GET", base+"/changes", nil, nil) // nothing to compare with yet
	dev := joinAs(t, env, admin, "chg", "chgdev", "developer")
	dev.must(403, "POST", base+"/snapshots", nil, nil)
	var snap struct {
		ID, Reason string
		TakenBy    string `json:"taken_by"`
	}
	admin.must(201, "POST", base+"/snapshots", nil, &snap)
	if snap.Reason != "manual" || snap.TakenBy != "admin" {
		t.Fatalf("snapshot = %+v", snap)
	}

	conn := openTestDB(t, env.dbURL)
	if _, err := conn.Exec(t.Context(), `create function public.probe_backdoor() returns void language sql security definer as 'select 1'`); err != nil {
		t.Fatal(err)
	}
	type change struct{ Key string }
	var changes struct {
		Since      struct{ ID string }
		Superuser  bool
		Categories []struct {
			Name    string
			Skipped *string
			Added   []change
			Removed []change
			Changed []change
		}
	}
	dev.must(200, "GET", base+"/changes?since="+snap.ID, nil, &changes)
	if changes.Since.ID != snap.ID || changes.Superuser {
		t.Fatalf("changes = %+v", changes)
	}
	for _, c := range changes.Categories {
		switch c.Name {
		case "security_definer_functions":
			if len(c.Added) != 1 || c.Added[0].Key != "probe_backdoor()" || len(c.Removed)+len(c.Changed) != 0 {
				t.Errorf("functions = %+v", c)
			}
		case "cron_jobs", "auth_users": // plain Postgres: not there
			if c.Skipped == nil {
				t.Errorf("%s wasn't skipped", c.Name)
			}
		default:
			if len(c.Added)+len(c.Removed)+len(c.Changed) != 0 || c.Skipped != nil {
				t.Errorf("%s = %+v", c.Name, c)
			}
		}
	}
	var list []struct{ ID string }
	admin.must(200, "GET", base+"/snapshots", nil, &list)
	if len(list) != 1 || list[0].ID != snap.ID {
		t.Fatalf("snapshots = %+v", list)
	}
	ro := joinAs(t, env, admin, "chg", "chgro", "read_only")
	ro.must(403, "GET", base+"/changes", nil, nil)
}
