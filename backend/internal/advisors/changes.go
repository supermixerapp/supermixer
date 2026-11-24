package advisors

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// After a suspect deploy, or someone with access leaving, rotating keys
// isn't enough: they may have left a way back in inside the database. A
// snapshot fingerprints the objects that could (roles, SECURITY DEFINER
// functions, triggers, event triggers, cron jobs, Auth users' passwords and
// roles), and comparing one with the database now lists what changed since.
// Snapshots keep hashes, not the text of functions, cron commands or
// passwords.

// Category is one kind of object a snapshot covers.
type Category struct {
	Name, Label string
	// Checks, run in order, are SQL returning whether the category can be
	// read here (its table exists and is visible); separate statements,
	// since a query naming a missing table fails before it runs.
	Checks []string
	// SQL returns rows of key (text) and value (json) for each object.
	SQL string
}

// Categories are what a snapshot covers. As a superuser (supabase_admin, in
// stacks Supermixer created) role passwords are fingerprinted too, and
// every role's cron jobs are visible.
func Categories(superuser bool) []Category {
	roles := `select r.rolname as key, json_build_object(
  'superuser', r.rolsuper, 'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb, 'login', r.rolcanlogin,
  'replication', r.rolreplication, 'bypassrls', r.rolbypassrls, 'valid_until', r.rolvaliduntil, 'config', r.rolconfig,
  'member_of', coalesce((select json_agg(b.rolname order by b.rolname) from pg_auth_members m
    join pg_roles b on b.oid = m.roleid where m.member = r.oid), '[]'::json)) as value
from pg_roles r where r.rolname !~ '^pg_'`
	if superuser {
		roles = `select r.rolname as key, json_build_object(
  'superuser', r.rolsuper, 'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb, 'login', r.rolcanlogin,
  'replication', r.rolreplication, 'bypassrls', r.rolbypassrls, 'valid_until', r.rolvaliduntil,
  'config', (select s.setconfig from pg_db_role_setting s where s.setrole = r.oid and s.setdatabase = 0),
  'password_md5', md5(coalesce(r.rolpassword, '')),
  'member_of', coalesce((select json_agg(b.rolname order by b.rolname) from pg_auth_members m
    join pg_roles b on b.oid = m.roleid where m.member = r.oid), '[]'::json)) as value
from pg_authid r where r.rolname !~ '^pg_'`
	}
	return []Category{
		{Name: "roles", Label: "Roles", SQL: roles},
		{Name: "security_definer_functions", Label: "SECURITY DEFINER functions", SQL: `select p.oid::regprocedure::text as key,
  json_build_object('owner', pg_get_userbyid(p.proowner), 'source_md5', md5(coalesce(p.prosrc, '')), 'config', p.proconfig) as value
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`},
		{Name: "triggers", Label: "Triggers", SQL: `select t.tgrelid::regclass::text || ': ' || t.tgname as key,
  json_build_object('function', t.tgfoid::regprocedure::text, 'enabled', t.tgenabled, 'definition_md5', md5(pg_get_triggerdef(t.oid))) as value
from pg_trigger t where not t.tgisinternal`},
		{Name: "event_triggers", Label: "Event triggers", SQL: `select e.evtname as key,
  json_build_object('event', e.evtevent, 'function', e.evtfoid::regprocedure::text, 'enabled', e.evtenabled,
    'tags', e.evttags, 'owner', pg_get_userbyid(e.evtowner)) as value
from pg_event_trigger e`},
		{Name: "cron_jobs", Label: "Cron jobs",
			Checks: []string{`select coalesce(has_table_privilege(to_regclass('cron.job'), 'select'), false)`},
			SQL: `select j.jobid::text || coalesce(' ' || j.jobname, '') as key,
  json_build_object('schedule', j.schedule, 'command_md5', md5(j.command), 'username', j.username,
    'database', j.database, 'active', j.active) as value
from cron.job j`},
		{Name: "auth_users", Label: "Auth users (password, role, app metadata or ban)",
			Checks: []string{`select coalesce(has_table_privilege(to_regclass('auth.users'), 'select'), false)`,
				`select (select count(*) from auth.users) <= 50000`},
			SQL: `select u.id::text as key, to_json(md5(concat_ws('|', u.encrypted_password, u.role, u.raw_app_meta_data::text,
  u.banned_until::text, u.is_super_admin::text, u.deleted_at::text))) as value
from auth.users u`},
	}
}

// Runner runs SQL that returns one JSON value, read-only, and returns that value.
type Runner func(ctx context.Context, sql string) ([]byte, error)

// Snapshot is a database's fingerprints, by category and key.
type Snapshot struct {
	Objects map[string]map[string]json.RawMessage `json:"objects"`
	// Skipped are categories that couldn't be read, with why.
	Skipped   map[string]string `json:"skipped,omitempty"`
	Superuser bool              `json:"superuser"`
}

// Take fingerprints the database.
func Take(ctx context.Context, run Runner, superuser bool) (Snapshot, error) {
	s := Snapshot{Objects: map[string]map[string]json.RawMessage{}, Skipped: map[string]string{}, Superuser: superuser}
	for _, c := range Categories(superuser) {
		readable := true
		for _, check := range c.Checks {
			out, err := run(ctx, "select to_json(("+check+"))")
			if err != nil {
				return s, fmt.Errorf("%s: %w", c.Label, err)
			}
			if strings.TrimSpace(string(out)) != "true" {
				readable = false
				break
			}
		}
		if !readable {
			s.Skipped[c.Name] = "not there, not readable, or too many to compare"
			continue
		}
		out, err := run(ctx, "select coalesce(json_object_agg(key, value), '{}'::json) from (\n"+c.SQL+"\n) objects")
		if err != nil {
			return s, fmt.Errorf("%s: %w", c.Label, err)
		}
		var objects map[string]json.RawMessage
		if err := json.Unmarshal(out, &objects); err != nil {
			return s, fmt.Errorf("%s: %w", c.Label, err)
		}
		s.Objects[c.Name] = objects
	}
	return s, nil
}

// Same reports whether two snapshots have the same objects and fingerprints.
func Same(a, b Snapshot) bool {
	if a.Superuser != b.Superuser || len(a.Objects) != len(b.Objects) || len(a.Skipped) != len(b.Skipped) {
		return false
	}
	for name := range a.Skipped {
		if _, ok := b.Skipped[name]; !ok {
			return false
		}
	}
	for name, objects := range a.Objects {
		other, ok := b.Objects[name]
		if !ok || len(objects) != len(other) {
			return false
		}
		for k, v := range objects {
			if w, ok := other[k]; !ok || !sameJSON(v, w) {
				return false
			}
		}
	}
	return true
}

// Change is one object added, removed or changed.
type Change struct {
	Key    string          `json:"key"`
	Before json.RawMessage `json:"before,omitempty"`
	After  json.RawMessage `json:"after,omitempty"`
}

// CategoryDiff is what changed in one category.
type CategoryDiff struct {
	Name    string   `json:"name"`
	Label   string   `json:"label"`
	Added   []Change `json:"added"`
	Removed []Change `json:"removed"`
	Changed []Change `json:"changed"`
	// Skipped says why the category couldn't be compared.
	Skipped string `json:"skipped,omitempty"`
}

// Diff compares an earlier snapshot with a later one.
func Diff(before, after Snapshot) []CategoryDiff {
	var out []CategoryDiff
	for _, c := range Categories(after.Superuser) {
		d := CategoryDiff{Name: c.Name, Label: c.Label, Added: []Change{}, Removed: []Change{}, Changed: []Change{}}
		b, okB := before.Objects[c.Name]
		a, okA := after.Objects[c.Name]
		switch {
		case !okB:
			d.Skipped = "the snapshot didn't cover it"
			if r := before.Skipped[c.Name]; r != "" {
				d.Skipped = "the snapshot couldn't read it: " + r
			}
		case !okA:
			d.Skipped = "can't read it now: " + after.Skipped[c.Name]
		default:
			for _, k := range slices.Sorted(keys(a)) {
				old, ok := b[k]
				switch {
				case !ok:
					d.Added = append(d.Added, Change{Key: k, After: a[k]})
				case !sameJSON(old, a[k]):
					d.Changed = append(d.Changed, Change{Key: k, Before: old, After: a[k]})
				}
			}
			for _, k := range slices.Sorted(keys(b)) {
				if _, ok := a[k]; !ok {
					d.Removed = append(d.Removed, Change{Key: k, Before: b[k]})
				}
			}
		}
		out = append(out, d)
	}
	return out
}

func keys(m map[string]json.RawMessage) func(func(string) bool) {
	return func(yield func(string) bool) {
		for k := range m {
			if !yield(k) {
				return
			}
		}
	}
}

// sameJSON compares JSON values regardless of spacing and key order.
func sameJSON(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return bytes.Equal(a, b)
	}
	ja, _ := json.Marshal(x)
	jb, _ := json.Marshal(y)
	return bytes.Equal(ja, jb)
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// UserEmails looks up the emails of Auth users by id (for showing changes;
// snapshots don't keep them).
func UserEmails(ctx context.Context, run Runner, ids []string) (map[string]string, error) {
	var valid []string
	for _, id := range ids {
		if uuidRe.MatchString(id) {
			valid = append(valid, "'"+id+"'")
		}
	}
	out := map[string]string{}
	if len(valid) == 0 {
		return out, nil
	}
	sort.Strings(valid)
	b, err := run(ctx, "select coalesce(json_object_agg(id::text, coalesce(email, phone, '')), '{}'::json) from auth.users where id in ("+
		strings.Join(valid, ", ")+")")
	if err != nil {
		return nil, err
	}
	return out, json.Unmarshal(b, &out)
}
