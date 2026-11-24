package advisors

import (
	"context"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/stack"
)

func TestWrapKeepsSplinterIntact(t *testing.T) {
	if len(SQL) <= len(splinter) {
		t.Fatal("not wrapped")
	}
	for _, want := range []string{"set local search_path = ''", "to_json(categories) as categories", "rls_disabled_in_public"} {
		if !contains(SQL, want) {
			t.Errorf("missing %q", want)
		}
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

// Runs splinter read-only on a Supabase database (it needs Supabase's roles,
// such as anon), with one table that has RLS off, which it must report. Set
// SUPERMIXER_TEST_SUPABASE_DB_URL, e.g. to the dev stack from make stack.
func TestSplinterRuns(t *testing.T) {
	raw := os.Getenv("SUPERMIXER_TEST_SUPABASE_DB_URL")
	if raw == "" {
		t.Skip("SUPERMIXER_TEST_SUPABASE_DB_URL isn't set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Skipf("no test Postgres (%v)", err)
	}
	if _, err := c.Exec(ctx, `create table if not exists public.splinter_probe (id int)`); err != nil {
		c.Close(ctx)
		t.Fatal(err)
	}
	// Drop it with the same connection before closing that connection.
	defer func() {
		if _, err := c.Exec(context.Background(), `drop table if exists public.splinter_probe`); err != nil {
			t.Errorf("dropping the probe table: %v", err)
		}
		c.Close(context.Background())
	}()

	// Supermixer's own check: the JWT secret as a setting (set for this session only).
	count := func() int {
		rows, err := c.Query(ctx, supermixerSQL)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for rows.Next() {
			n++
		}
		rows.Close()
		return n
	}
	if _, err := c.Exec(ctx, `reset "app.settings.jwt_secret"`); err != nil {
		t.Fatal(err)
	}
	baseline := count()
	if _, err := c.Exec(ctx, `set "app.settings.jwt_secret" = 'probe'`); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 1 {
		t.Errorf("with the setting: %d rows", n)
	}
	if _, err := c.Exec(ctx, `set "app.settings.jwt_secret" = ''`); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 0 {
		t.Errorf("with the setting empty: %d rows (baseline %d)", n, baseline)
	}

	u, _ := url.Parse(raw)
	pw, _ := u.User.Password()
	port, _ := strconv.Atoi(u.Port())
	db := stack.Database{Host: u.Hostname(), Port: port, Name: u.Path[1:], User: u.User.Username(), Password: pw, SSLMode: "disable"}
	p := stack.NewPools(2)
	t.Cleanup(p.Close)
	res, err := p.Query(ctx, "advisors-test", db, SQL, stack.QueryOptions{ReadOnly: true, Trusted: true, MaxRows: 10000})
	if err != nil {
		t.Fatal(err)
	}
	lints, err := FromResult(res[len(res)-1])
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range lints {
		if l.Name == "rls_disabled_in_public" && string(l.Metadata) != "" && contains(string(l.Metadata), "splinter_probe") {
			if len(l.Categories) != 1 || l.Categories[0] != "SECURITY" || l.Level != "ERROR" {
				t.Fatalf("lint = %+v", l)
			}
			return
		}
	}
	t.Fatalf("RLS off on splinter_probe wasn't reported; got %d lints", len(lints))
}
