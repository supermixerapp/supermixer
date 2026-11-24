// Package advisors runs Supabase's database linter, splinter
// (https://github.com/supabase/splinter, PostgreSQL License; see
// SPLINTER_LICENSE), the checks behind Studio's Security and Performance
// Advisors. splinter.sql is vendored unchanged.
package advisors

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"supermixer/internal/stack"
)

//go:embed splinter.sql
var splinter string

// SQL is splinter's setup block followed by its lint query, wrapped so the
// categories array comes back as JSON (the query runner returns Postgres
// arrays as text). It only reads, and must run in a read-only transaction.
var SQL = mustWrap(splinter)

const setupEnd = "\nend $$;\n"

func mustWrap(src string) string {
	i := strings.Index(src, setupEnd)
	if i < 0 {
		panic("advisors: splinter.sql no longer starts with its DO block")
	}
	head := src[:i+len(setupEnd)]
	query := strings.TrimSpace(src[i+len(setupEnd):])
	return head + "\nselect name, title, level, facing, to_json(categories) as categories, description, detail, remediation, metadata, cache_key\nfrom (\n" + query + "\n) lints\nunion all\n" + supermixerSQL
}

// supermixerSQL is Supermixer's own database check, in splinter's shape:
// the JWT secret kept as a database setting, where any SQL can read it
// (current_setting) and so mint tokens for any role. Older self-hosted
// templates set it; Supabase's current one doesn't need it.
const supermixerSQL = `select 'jwt_secret_in_database'::text as name,
  'JWT secret stored as a database setting'::text as title,
  'WARN'::text as level, 'EXTERNAL'::text as facing,
  to_json(array['SECURITY']::text[]) as categories,
  'The setting ` + "`" + `app.settings.jwt_secret` + "`" + ` holds the JWT secret. Any SQL that runs in the database, including functions called through the Data API, can read it with ` + "`" + `current_setting()` + "`" + ` and sign tokens for any role, service_role included.'::text as description,
  'The database setting ` + "`" + `app.settings.jwt_secret` + "`" + ` is set.'::text as detail,
  'Check that none of your own SQL reads ` + "`" + `app.settings.jwt_secret` + "`" + `, then run ` + "`" + `ALTER DATABASE postgres RESET "app.settings.jwt_secret";` + "`" + ` and rotate the JWT secret, since it may have been read.'::text as remediation,
  jsonb_build_object('name', 'app.settings.jwt_secret', 'type', 'setting') as metadata,
  'jwt_secret_in_database'::text as cache_key
where coalesce(current_setting('app.settings.jwt_secret', true), '') <> ''`

// ExampleSecretsLint reports credentials of a stack that are public example
// values (provision.ExampleSecrets); nil when there are none.
func ExampleSecretsLint(found []string) *Lint {
	if len(found) == 0 {
		return nil
	}
	meta, _ := json.Marshal(map[string]any{"name": strings.Join(found, ", "), "type": "credentials"})
	return &Lint{
		Name: "example_secrets", Title: "Stack uses Supabase's example secrets", Level: "ERROR", Facing: "EXTERNAL",
		Categories: []string{"SECURITY"},
		Description: "Self-hosted Supabase's example secrets are public. With the example JWT secret anyone can sign a " +
			"service_role token and bypass Row Level Security; with the example database password anyone who reaches " +
			"the database can log in.",
		Detail: "These credentials Supermixer has for the stack are Supabase's published examples: " + strings.Join(found, ", ") + ".",
		Remediation: "Generate new secrets (see Supabase's self-hosting guide: Securing your services), update the stack's `.env` " +
			"and restart it, then update this project's connection in Supermixer. Change the other example values in the " +
			"stack's `.env` too (`DASHBOARD_PASSWORD`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`, the Logflare tokens): " +
			"Supermixer can't check those from outside.",
		Metadata: meta, CacheKey: "example_secrets",
	}
}

// Lint is one finding.
type Lint struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Level       string          `json:"level"` // ERROR, WARN or INFO
	Facing      string          `json:"facing"`
	Categories  []string        `json:"categories"`
	Description string          `json:"description"`
	Detail      string          `json:"detail"`
	Remediation string          `json:"remediation"`
	Metadata    json.RawMessage `json:"metadata"`
	CacheKey    string          `json:"cache_key"`
}

// FromResult reads lints from the query's last result.
func FromResult(r stack.Result) ([]Lint, error) {
	col := map[string]int{}
	for i, c := range r.Columns {
		col[c.Name] = i
	}
	for _, name := range []string{"name", "title", "level", "facing", "categories", "description", "detail", "remediation", "metadata", "cache_key"} {
		if _, ok := col[name]; !ok {
			return nil, fmt.Errorf("advisors: no %q column in splinter's result", name)
		}
	}
	text := func(row []any, name string) string {
		if s, ok := row[col[name]].(string); ok {
			return s
		}
		return ""
	}
	raw := func(row []any, name string) json.RawMessage {
		if m, ok := row[col[name]].(json.RawMessage); ok {
			return m
		}
		return json.RawMessage("null")
	}
	out := make([]Lint, 0, len(r.Rows))
	for _, row := range r.Rows {
		l := Lint{
			Name: text(row, "name"), Title: text(row, "title"), Level: text(row, "level"), Facing: text(row, "facing"),
			Description: text(row, "description"), Detail: text(row, "detail"), Remediation: text(row, "remediation"),
			Metadata: raw(row, "metadata"), CacheKey: text(row, "cache_key"), Categories: []string{},
		}
		if err := json.Unmarshal(raw(row, "categories"), &l.Categories); err != nil || l.Categories == nil {
			l.Categories = []string{}
		}
		out = append(out, l)
	}
	return out, nil
}
