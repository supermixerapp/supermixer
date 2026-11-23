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
	return head + "\nselect name, title, level, facing, to_json(categories) as categories, description, detail, remediation, metadata, cache_key\nfrom (\n" + query + "\n) lints"
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
