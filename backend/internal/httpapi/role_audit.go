package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"time"

	"supermixer/internal/stack"
)

// Postgres logins connect straight to a project's database, so Supermixer's
// roles and audit log don't follow them, and removing someone from an
// organization leaves any login they made working. So that an admin can at
// least find those logins, a SQL run that can write (the SQL Editor, the
// Roles page, the /v1 query endpoint) and could touch roles compares the
// database's roles before and after it and records what changed, under the
// person who ran it.
//
// Roles belong to the whole server, so something else (psql, Supermixer
// itself, another person's run) may change one during the run. A change to a
// role the SQL doesn't name is still recorded, but marked as possibly not
// theirs.

// dbRole is what's compared for one role.
type dbRole struct {
	Name            string   `json:"name"`
	Superuser       bool     `json:"superuser"`
	CreateRole      bool     `json:"createrole"`
	CreateDB        bool     `json:"createdb"`
	Login           bool     `json:"login"`
	Replication     bool     `json:"replication"`
	BypassRLS       bool     `json:"bypassrls"`
	ConnectionLimit int      `json:"connection_limit"`
	ValidUntil      *string  `json:"valid_until"`
	MemberOf        []string `json:"member_of"`
}

// dbRoles is one read: the roles by oid (so a rename shows as a change rather
// than a drop and a create), and the login the connection uses.
type dbRoles struct {
	Login string            `json:"login"`
	Roles map[string]dbRole `json:"roles"`
}

// Expiry is formatted in UTC so a run that changes the session's time zone
// doesn't make every expiry look changed. A membership granted twice (by
// different grantors, on Postgres 16) counts once.
const dbRolesSQL = `select json_build_object('login', current_user, 'roles', coalesce(json_object_agg(r.oid::text, json_build_object(
  'name', r.rolname, 'superuser', r.rolsuper, 'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb,
  'login', r.rolcanlogin, 'replication', r.rolreplication, 'bypassrls', r.rolbypassrls,
  'connection_limit', r.rolconnlimit,
  'valid_until', case when isfinite(r.rolvaliduntil) then to_char(r.rolvaliduntil at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC'
    else r.rolvaliduntil::text end,
  'member_of', coalesce((select json_agg(g order by g) from (select distinct b.rolname || case when m.admin_option then ' (with admin option)' else '' end as g
    from pg_auth_members m join pg_roles b on b.oid = m.roleid where m.member = r.oid) grants), '[]'::json))), '{}'::json))
from pg_roles r where r.rolname !~ '^pg_'`

// roleReadTimeout bounds each read, so auditing never holds a request long.
const roleReadTimeout = 5 * time.Second

// readDBRoles reads a project's roles through the same login the run uses.
// An error means the run isn't audited for roles, not that it fails.
func (h *handlers) readDBRoles(ctx context.Context, ref string, d stack.Database) (*dbRoles, error) {
	results, err := h.pools.Query(ctx, ref, d, dbRolesSQL, stack.QueryOptions{ReadOnly: true, Trusted: true, MaxRows: 1, Timeout: roleReadTimeout})
	if err != nil {
		return nil, err
	}
	if len(results) == 0 || len(results[0].Rows) == 0 || len(results[0].Rows[0]) == 0 {
		return nil, errors.New("reading roles returned nothing")
	}
	var raw []byte
	switch v := results[0].Rows[0][0].(type) {
	case json.RawMessage:
		raw = v
	case string:
		raw = []byte(v)
	case []byte:
		raw = v
	default:
		if raw, err = json.Marshal(v); err != nil {
			return nil, err
		}
	}
	var out dbRoles
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// mayChangeRolesRe matches SQL that could create, change or drop a role:
// role statements, grants, DO blocks, and calls that could run any of them.
// Runs without any of these (most Table Editor and GraphQL calls) aren't
// compared, which keeps them fast and keeps other people's changes off them.
var mayChangeRolesRe = regexp.MustCompile(`(?i)\b(role|user|group|grant|revoke|execute|call|password)\b|\bdo\s*(\$|'|language\b)`)

func mayChangeRoles(sql string) bool { return mayChangeRolesRe.MatchString(sql) }

// rolesBeforeRun reads the roles before a run that could change them; nil if
// it couldn't, or needn't.
func (h *handlers) rolesBeforeRun(ctx context.Context, a *projectAccess, poolKey string, d stack.Database, sql string) *dbRoles {
	if !mayChangeRoles(sql) {
		return nil
	}
	before, err := h.readDBRoles(ctx, poolKey, d)
	if err != nil {
		h.deps.Logger.WarnContext(ctx, "couldn't read roles before a query; role changes won't be audited", "ref", a.Project().Ref, "err", err)
		return nil
	}
	return before
}

// auditRoleChanges reads the roles again after a run and records what changed.
// runErr is the run's error: if the database couldn't be reached there's no
// point reading again; if a statement failed part-way, earlier ones may still
// have changed roles, so it's compared, but the SQL is only trusted about
// passwords when the whole run succeeded.
func (h *handlers) auditRoleChanges(ctx context.Context, a *projectAccess, poolKey string, d stack.Database, sql string, before *dbRoles, runErr error) {
	var qe *stack.QueryError
	if runErr != nil && !errors.As(runErr, &qe) {
		return
	}
	// Record it even if the caller has gone away, but don't wait long.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), roleReadTimeout+time.Second)
	defer cancel()
	after, err := h.readDBRoles(ctx, poolKey, d)
	if err != nil {
		h.deps.Logger.WarnContext(ctx, "couldn't read roles after a query; role changes won't be audited", "ref", a.Project().Ref, "err", err)
		return
	}
	passwords := map[string]passwordChange{}
	if runErr == nil {
		passwords = passwordsSetIn(sql, before.Login)
	}
	p := a.Project()
	for _, c := range diffDBRoles(before.Roles, after.Roles, passwords, sql) {
		c.Metadata["role"] = c.Role
		h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: c.Action,
			TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: c.Metadata})
	}
}

// passwordChange is what a statement did to a role's password.
type passwordChange string

const (
	passwordSet     passwordChange = "set"
	passwordRemoved passwordChange = "removed"
)

// passwordRe finds CREATE/ALTER ROLE (or USER) statements that set or remove
// a password: the name, what comes between it and PASSWORD, and NULL if it's
// removed. pg_roles doesn't show passwords, so a new password on an existing
// login is only seen in the SQL. It runs on SQL with comments removed and
// string literals emptied (see blankSQL), so neither can fake a match.
var passwordRe = regexp.MustCompile(`(?is)\b(?:create|alter)\s+(?:role|user)\s+("(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)([^;]*?)(?:^|\s)password\b\s*(null\b)?`)

// notAPasswordRe rules out matches that aren't a role's password: a SET or
// RESET clause (alter role bob set app.password = …) or a user mapping
// (create user mapping for bob … options (password …)).
var notAPasswordRe = regexp.MustCompile(`(?i)\b(re)?set\b|^\s*for\b`)

// passwordsSetIn returns the roles whose password the SQL sets or removes.
// login is the connection's role, which CURRENT_USER and friends stand for.
func passwordsSetIn(sql, login string) map[string]passwordChange {
	out := map[string]passwordChange{}
	for _, m := range passwordRe.FindAllStringSubmatch(blankSQL(sql), -1) {
		name, between := m[1], m[2]
		if strings.EqualFold(name, "mapping") || notAPasswordRe.MatchString(between) {
			continue
		}
		switch {
		case strings.HasPrefix(name, `"`):
			name = strings.ReplaceAll(name[1:len(name)-1], `""`, `"`)
		case slices.Contains([]string{"current_user", "current_role", "session_user"}, strings.ToLower(name)):
			name = login
		default:
			name = strings.ToLower(name)
		}
		if m[3] != "" {
			out[name] = passwordRemoved
		} else {
			out[name] = passwordSet
		}
	}
	return out
}

// blankSQL removes comments and empties single-quoted strings, keeping
// quoted identifiers and dollar-quoted bodies (the code of DO blocks and
// functions) as they are.
func blankSQL(sql string) string {
	var b strings.Builder
	for i := 0; i < len(sql); {
		switch {
		case strings.HasPrefix(sql[i:], "--"):
			end := strings.IndexByte(sql[i:], '\n')
			if end < 0 {
				return b.String()
			}
			b.WriteByte(' ')
			i += end
		case strings.HasPrefix(sql[i:], "/*"):
			depth, j := 1, i+2
			for j < len(sql) && depth > 0 {
				switch {
				case strings.HasPrefix(sql[j:], "/*"):
					depth, j = depth+1, j+2
				case strings.HasPrefix(sql[j:], "*/"):
					depth, j = depth-1, j+2
				default:
					j++
				}
			}
			b.WriteByte(' ')
			i = j
		case sql[i] == '\'':
			// E'…' strings allow backslash escapes; others only ''.
			escapes := i > 0 && (sql[i-1] == 'e' || sql[i-1] == 'E')
			j := i + 1
			for j < len(sql) {
				if escapes && sql[j] == '\\' {
					j += 2
					continue
				}
				if sql[j] == '\'' {
					if j+1 < len(sql) && sql[j+1] == '\'' {
						j += 2
						continue
					}
					break
				}
				j++
			}
			b.WriteString("''")
			i = j + 1
		case sql[i] == '"':
			end := strings.IndexByte(sql[i+1:], '"')
			for end >= 0 && i+2+end < len(sql) && sql[i+2+end] == '"' {
				next := strings.IndexByte(sql[i+3+end:], '"')
				if next < 0 {
					end = -1
					break
				}
				end += 2 + next
			}
			if end < 0 {
				b.WriteString(sql[i:])
				return b.String()
			}
			b.WriteString(sql[i : i+2+end])
			i += 2 + end
		default:
			b.WriteByte(sql[i])
			i++
		}
	}
	return b.String()
}

// roleChange is one audit entry's worth.
type roleChange struct {
	Action   string // project.database_role_created, _updated or _dropped
	Role     string
	Metadata map[string]any
}

// diffDBRoles lists what changed between two reads. passwords are the roles
// whose password the run set or removed; sql is the run, to tell changes it
// names from ones that may have come from elsewhere.
func diffDBRoles(before, after map[string]dbRole, passwords map[string]passwordChange, sql string) []roleChange {
	names := map[string]bool{}
	for _, r := range after {
		names[r.Name] = true
	}
	lower := strings.ToLower(sql)
	named := func(names ...string) bool {
		for _, n := range names {
			if strings.Contains(lower, strings.ToLower(n)) {
				return true
			}
		}
		return false
	}
	var out []roleChange
	add := func(action, role string, meta map[string]any, mentioned bool) {
		if !mentioned {
			meta["note"] = "changed while their query ran, but the query doesn't name it: it may not be theirs"
		}
		out = append(out, roleChange{action, role, meta})
	}
	for _, oid := range slices.Sorted(maps.Keys(after)) {
		r := after[oid]
		old, existed := before[oid]
		if !existed {
			meta := map[string]any{}
			for _, f := range roleFlags(r) {
				if f.on {
					meta[f.name] = true
				}
			}
			if len(r.MemberOf) > 0 {
				meta["member_of"] = r.MemberOf
			}
			if r.ValidUntil != nil {
				meta["valid_until"] = *r.ValidUntil
			}
			if passwords[r.Name] == passwordSet {
				meta["password"] = "set"
			}
			add("project.database_role_created", r.Name, meta, named(r.Name))
			continue
		}
		changes := map[string]any{}
		if old.Name != r.Name {
			changes["name"] = old.Name + " → " + r.Name
		}
		oldFlags := roleFlags(old)
		for i, f := range roleFlags(r) {
			if f.on != oldFlags[i].on {
				changes[f.name] = onOff(oldFlags[i].on) + " → " + onOff(f.on)
			}
		}
		if old.ConnectionLimit != r.ConnectionLimit {
			changes["connection_limit"] = fmt.Sprintf("%d → %d", old.ConnectionLimit, r.ConnectionLimit)
		}
		if deref(old.ValidUntil) != deref(r.ValidUntil) {
			changes["valid_until"] = orNone(deref(old.ValidUntil)) + " → " + orNone(deref(r.ValidUntil))
		}
		if added := missing(r.MemberOf, old.MemberOf); len(added) > 0 {
			changes["member_of_added"] = added
		}
		if removed := missing(old.MemberOf, r.MemberOf); len(removed) > 0 {
			changes["member_of_removed"] = removed
		}
		// By its old name only if no role has that name now, or a new role
		// given the old name would count as a change to this one.
		pw := passwords[r.Name]
		if pw == "" && old.Name != r.Name && !names[old.Name] {
			pw = passwords[old.Name]
		}
		switch pw {
		case passwordSet:
			changes["password"] = "changed"
		case passwordRemoved:
			changes["password"] = "removed"
		}
		if len(changes) > 0 {
			// A password change on the connection's own login names it as
			// CURRENT_USER, which passwordsSetIn already resolved.
			add("project.database_role_updated", r.Name, changes, pw != "" || named(r.Name, old.Name))
		}
	}
	for _, oid := range slices.Sorted(maps.Keys(before)) {
		if _, ok := after[oid]; !ok {
			add("project.database_role_dropped", before[oid].Name, map[string]any{}, named(before[oid].Name))
		}
	}
	return out
}

type roleFlag struct {
	name string
	on   bool
}

func roleFlags(r dbRole) []roleFlag {
	return []roleFlag{
		{"login", r.Login}, {"superuser", r.Superuser}, {"bypass_rls", r.BypassRLS}, {"create_role", r.CreateRole},
		{"create_db", r.CreateDB}, {"replication", r.Replication},
	}
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

// missing returns the items of a that aren't in b.
func missing(a, b []string) []string {
	var out []string
	for _, x := range a {
		if !slices.Contains(b, x) {
			out = append(out, x)
		}
	}
	return out
}
