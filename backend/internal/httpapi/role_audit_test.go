package httpapi

import (
	"fmt"
	"maps"
	"strings"
	"testing"
	"time"
)

func TestPasswordsSetIn(t *testing.T) {
	got := passwordsSetIn(`create role "Mixed ""Q""" with login password 'SCRAM-SHA-256$4096:abc';
ALTER USER bob WITH PASSWORD NULL;
alter role carol nologin;
create role dave; select 'alter role mallory password ''x''';
-- alter role trent password 'x'
/* alter role /* nested */ peggy password 'x' */
alter role victor set app.password = 'x';
create user mapping for walter server s options (user 'w', password 'x');
alter user current_user password 'mine';
alter role Erin valid until 'infinity' password'x'`, "postgres")
	want := map[string]passwordChange{`Mixed "Q"`: passwordSet, "bob": passwordRemoved, "postgres": passwordSet, "erin": passwordSet}
	if !maps.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMayChangeRoles(t *testing.T) {
	for sql, want := range map[string]bool{
		"select * from auth.users":                        false,
		"insert into t values (1) on conflict do nothing": false,
		"update things set name = 'x' where id = 1":       false,
		"select current_user":                             false,
		"create role x":                                   true,
		"grant authenticated to x":                        true,
		"do $$ begin perform 1; end $$":                   true,
		"DO language plpgsql 'begin end'":                 true,
		"alter user x password 'y'":                       true,
		"select make_login()":                             false, // not seen: a known limit
	} {
		if got := mayChangeRoles(sql); got != want {
			t.Errorf("mayChangeRoles(%q) = %v, want %v", sql, got, want)
		}
	}
}

func TestDiffDBRoles(t *testing.T) {
	before := map[string]dbRole{
		"1": {Name: "kept"},
		"2": {Name: "old_name", MemberOf: []string{"authenticated"}},
		"3": {Name: "gone"},
		"5": {Name: "renamed_away"},
	}
	after := map[string]dbRole{
		"1": {Name: "kept"},
		"2": {Name: "new_name", Login: true, BypassRLS: true, MemberOf: []string{"service_role"}},
		"4": {Name: "fresh", Login: true, MemberOf: []string{"postgres"}},
		"5": {Name: "moved"},
		"6": {Name: "renamed_away"},
		"7": {Name: "elsewhere"},
	}
	sql := "alter role kept password 'x'; alter role old_name rename to new_name; alter role new_name login bypassrls; " +
		"create role fresh login password 'x' in role postgres; drop role gone; " +
		"alter role renamed_away rename to moved; create role renamed_away password 'x'"
	passwords := map[string]passwordChange{"kept": passwordSet, "fresh": passwordSet, "renamed_away": passwordSet}
	var lines []string
	for _, c := range diffDBRoles(before, after, passwords, sql) {
		lines = append(lines, fmt.Sprintf("%s %s %v", c.Action, c.Role, c.Metadata))
	}
	want := []string{
		"project.database_role_updated kept map[password:changed]",
		"project.database_role_updated new_name map[bypass_rls:off → on login:off → on member_of_added:[service_role] member_of_removed:[authenticated] name:old_name → new_name]",
		"project.database_role_created fresh map[login:true member_of:[postgres] password:set]",
		// A new role took the old name, so the password is the new role's.
		"project.database_role_updated moved map[name:renamed_away → moved]",
		"project.database_role_created renamed_away map[password:set]",
		"project.database_role_created elsewhere map[note:changed while their query ran, but the query doesn't name it: it may not be theirs]",
		"project.database_role_dropped gone map[]",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("got\n%s\nwant\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

func TestRoleChangesAreAudited(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Logins"}, nil)
	_, gwURL := newRecordingGateway(t)
	var p struct{ Ref string }
	admin.must(201, "POST", "/organizations/logins/projects", map[string]any{"name": "P", "connection": connectionFor(t, gwURL, env.dbURL)}, &p)
	q := "/projects/" + p.Ref + "/query"
	dev := joinAs(t, env, admin, "logins", "dev", "developer")
	reader := joinAs(t, env, admin, "logins", "reader", "read_only")

	// Roles belong to the whole Postgres server, so use a name no other test
	// does, and drop it whatever happens.
	name := fmt.Sprintf("sm_audit_%d", time.Now().UnixNano())
	t.Cleanup(func() { admin.do("POST", q, map[string]any{"query": "drop role if exists " + name}, nil) })

	dev.must(200, "POST", q, map[string]any{"query": "create role " + name + " with login password 'first-one'"}, nil)
	dev.must(200, "POST", q, map[string]any{"query": "alter role " + name + " with bypassrls"}, nil)
	dev.must(200, "POST", q, map[string]any{"query": "alter role " + name + " password 'second-one'"}, nil)
	// A failing run that changed nothing records nothing.
	dev.do("POST", q, map[string]any{"query": "alter role " + name + " password 'x'; select 1/0"}, nil)
	// Neither does a time zone change, which once made every expiry look changed.
	dev.must(200, "POST", q, map[string]any{"query": "alter role " + name + " valid until '2030-01-01 00:00:00+00'"}, nil)
	dev.must(200, "POST", q, map[string]any{"query": "set timezone = 'Asia/Tokyo'; grant pg_monitor to " + name + "; grant pg_monitor to " + name}, nil)
	reader.do("POST", q, map[string]any{"query": "select 1"}, nil)
	dev.must(200, "POST", q, map[string]any{"query": "drop role " + name}, nil)

	var audit struct {
		Entries []struct {
			Action        string
			ActorUsername string `json:"actor_username"`
			Metadata      map[string]any
		}
	}
	admin.must(200, "GET", "/organizations/logins/audit-logs?limit=100", nil, &audit)
	var got []string
	for i := len(audit.Entries) - 1; i >= 0; i-- {
		e := audit.Entries[i]
		if !strings.HasPrefix(e.Action, "project.database_role_") || e.Metadata["role"] != name {
			continue
		}
		delete(e.Metadata, "role")
		got = append(got, fmt.Sprintf("%s %s %v", e.ActorUsername, strings.TrimPrefix(e.Action, "project.database_role_"), e.Metadata))
	}
	want := []string{
		"dev created map[login:true password:set]",
		"dev updated map[bypass_rls:off → on]",
		"dev updated map[password:changed]",
		"dev updated map[valid_until:(none) → 2030-01-01 00:00:00 UTC]",
		"dev updated map[member_of_added:[pg_monitor]]",
		"dev dropped map[]",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("audited\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}
