package provision

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Edge Functions get SUPABASE_DB_URL. Supabase's compose file makes it the
// postgres login, which bypasses Row Level Security, creates roles, and can
// change auth.users and Realtime's tables. Stacks
// Supermixer creates give functions functions_user instead: a login whose
// sessions act as service_role, the same access as the service-role key
// functions already have. A project can choose postgres again.

// FunctionsDBRole is the functions' database login.
const FunctionsDBRole = "functions_user"

// DBAccess is which database login functions get.
type DBAccess string

const (
	DBAccessServiceRole DBAccess = "service_role" // functions_user
	DBAccessPostgres    DBAccess = "postgres"
)

// FunctionsDBLogin is the user:password the overlay puts in SUPABASE_DB_URL.
// Both passwords are hex, so they need no escaping in a URL.
func FunctionsDBLogin(access DBAccess, env map[string]string) string {
	if access == DBAccessPostgres {
		return "postgres:" + env["POSTGRES_PASSWORD"]
	}
	return FunctionsDBRole + ":" + env["FUNCTIONS_DB_PASSWORD"]
}

// FunctionsDBAccessOf reads which login a stack's .env gives functions.
func FunctionsDBAccessOf(env map[string]string) DBAccess {
	if strings.HasPrefix(env["FUNCTIONS_DB_LOGIN"], "postgres:") {
		return DBAccessPostgres
	}
	return DBAccessServiceRole
}

// PrepareStack brings a stack's files up to this version before it starts:
// the current overlay, and the .env settings it needs (stacks created
// before they existed get them now).
func PrepareStack(dir string) error {
	if err := RefreshOverlay(dir); err != nil {
		return err
	}
	return PrepareEnv(dir)
}

// PrepareEnv adds the .env settings Supermixer needs that a stack created
// before they existed lacks.
func PrepareEnv(dir string) error {
	env, err := ReadEnv(dir)
	if err != nil {
		return err
	}
	set := map[string]string{}
	if env["FUNCTIONS_DB_PASSWORD"] == "" {
		b, err := random(16)
		if err != nil {
			return err
		}
		set["FUNCTIONS_DB_PASSWORD"] = fmt.Sprintf("%x", b)
		env["FUNCTIONS_DB_PASSWORD"] = set["FUNCTIONS_DB_PASSWORD"]
	}
	if env["FUNCTIONS_DB_LOGIN"] == "" {
		set["FUNCTIONS_DB_LOGIN"] = FunctionsDBLogin(DBAccessServiceRole, env)
	}
	if len(set) == 0 {
		return nil
	}
	return UpdateEnv(dir, set)
}

// UpdateEnv sets keys in a stack's .env, keeping everything else.
func UpdateEnv(dir string, values map[string]string) error {
	path := filepath.Join(dir, ".env")
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, ".env.tmp")
	if err := os.WriteFile(tmp, []byte(renderEnv(string(b), values)), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var hexPassword = regexp.MustCompile(`^[0-9a-f]{16,128}$`)

// EnsureFunctionsRole creates or updates functions_user in the stack's
// database, as supabase_admin inside the db container. It runs after every
// start, so it also repairs a role someone changed by hand.
func (c Compose) EnsureFunctionsRole(ctx context.Context, log io.Writer, password string) error {
	if !hexPassword.MatchString(password) {
		return fmt.Errorf("the functions' database password isn't a generated one")
	}
	// log_statement off first: the password must not reach the stack's logs.
	sql := `set log_statement = 'none';
do $do$
begin
  if not exists (select from pg_roles where rolname = '` + FunctionsDBRole + `') then
    create role ` + FunctionsDBRole + `;
  end if;
end
$do$;
alter role ` + FunctionsDBRole + ` with login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '` + password + `';
grant service_role to ` + FunctionsDBRole + `;
-- Sessions act as service_role (its grants and RLS bypass), nothing more.
alter role ` + FunctionsDBRole + ` set role = 'service_role';
comment on role ` + FunctionsDBRole + ` is 'Edge Functions log in as this (set up by Supermixer); sessions act as service_role.';
`
	return c.RunInput(ctx, log, strings.NewReader(sql),
		"exec", "-T", "db", "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-f", "-")
}
