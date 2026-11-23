package stack

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// testDB points at a plain Postgres (the dev compose one by default). It has
// no supabase_read_only_user, so read-only mode relies on READ ONLY alone.
func testDB(t *testing.T) Database {
	t.Helper()
	raw := os.Getenv("SUPERMIXER_TEST_DATABASE_URL")
	if raw == "" {
		raw = "postgres://supermixer:supermixer@localhost:5433/supermixer?sslmode=disable"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, err := pgx.Connect(ctx, raw)
	if err != nil {
		t.Skipf("no test Postgres (%v)", err)
	}
	_ = c.Close(ctx)
	u, _ := url.Parse(raw)
	pw, _ := u.User.Password()
	port, _ := strconv.Atoi(u.Port())
	return Database{Host: u.Hostname(), Port: port, Name: u.Path[1:], User: u.User.Username(), Password: pw, SSLMode: "disable"}
}

func TestQuery(t *testing.T) {
	d := testDB(t)
	p := NewPools(4)
	t.Cleanup(p.Close)
	ctx := context.Background()
	run := func(sql string, opt QueryOptions) ([]Result, error) {
		return p.Query(ctx, "testref", d, sql, opt)
	}

	t.Run("several statements, typed values", func(t *testing.T) {
		rs, err := run(`create temp table t (id int, ok bool, j jsonb, big int8);
			insert into t values (1, true, '{"a":1}', 9007199254740993), (2, null, null, null);
			select * from t order by id`, QueryOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if len(rs) != 3 || rs[1].Command != "INSERT" || rs[1].RowCount != 2 {
			t.Fatalf("results = %+v", rs)
		}
		sel := rs[2]
		if sel.Columns[0].Type != "int4" || sel.RowCount != 2 {
			t.Fatalf("select = %+v", sel)
		}
		row := sel.Rows[0]
		if row[0] != int64(1) || row[1] != true || string(row[2].(json.RawMessage)) != `{"a": 1}` || row[3] != "9007199254740993" {
			t.Fatalf("row = %#v", row)
		}
		if sel.Rows[1][1] != nil {
			t.Fatalf("null = %#v", sel.Rows[1][1])
		}
	})

	t.Run("JSON values survive later rows", func(t *testing.T) {
		// Enough rows that the connection's read buffer is reused.
		rs, err := run(`select json_build_object('i', i, 'pad', repeat('x', 2000)) as j from generate_series(1, 200) i`, QueryOptions{})
		if err != nil {
			t.Fatal(err)
		}
		for i, row := range rs[0].Rows {
			var v struct{ I int }
			if err := json.Unmarshal(row[0].(json.RawMessage), &v); err != nil || v.I != i+1 {
				t.Fatalf("row %d = %.40s… (%v)", i, row[0], err)
			}
		}
		if _, err := json.Marshal(rs); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("trusted read-only scripts run several statements but still can't write", func(t *testing.T) {
		rs, err := run(`set local search_path = ''; do $$ begin perform pg_catalog.set_config('x.y', 'ok', true); end $$; select pg_catalog.current_setting('x.y') as v`, QueryOptions{ReadOnly: true, Trusted: true})
		if err != nil {
			t.Fatal(err)
		}
		if last := rs[len(rs)-1]; len(last.Rows) != 1 || last.Rows[0][0] != "ok" {
			t.Fatalf("results = %+v", rs)
		}
		var qe *QueryError
		if _, err := run("select 1; create table trusted_write (a int)", QueryOptions{ReadOnly: true, Trusted: true}); !errors.As(err, &qe) || qe.Code != "25006" {
			t.Fatalf("write in a trusted read-only run: %v", err)
		}
		if _, err := run("select 1; select 2", QueryOptions{ReadOnly: true}); err == nil {
			t.Fatal("an untrusted read-only run accepted two statements")
		}
	})

	t.Run("row cap", func(t *testing.T) {
		rs, err := run("select generate_series(1, 50)", QueryOptions{MaxRows: 10})
		if err != nil {
			t.Fatal(err)
		}
		if !rs[0].Truncated || len(rs[0].Rows) != 10 || rs[0].RowCount != 50 {
			t.Fatalf("got %d rows, truncated=%v, count=%d", len(rs[0].Rows), rs[0].Truncated, rs[0].RowCount)
		}
	})

	t.Run("postgres errors keep their details", func(t *testing.T) {
		_, err := run("select nope from nowhere", QueryOptions{})
		var qe *QueryError
		if !errors.As(err, &qe) || qe.Code != "42P01" || qe.Position == 0 {
			t.Fatalf("err = %#v", err)
		}
	})

	t.Run("read-only blocks writes", func(t *testing.T) {
		_, err := run("create table ro_should_fail (id int)", QueryOptions{ReadOnly: true})
		var qe *QueryError
		if !errors.As(err, &qe) || qe.Code != "25006" {
			t.Fatalf("err = %#v", err)
		}
	})

	t.Run("read-only rejects smuggled statements", func(t *testing.T) {
		_, err := run("commit; create table ro_should_fail (id int)", QueryOptions{ReadOnly: true})
		if err == nil {
			t.Fatal("multi-statement string ran in read-only mode")
		}
		rs, err := run("select to_regclass('ro_should_fail') is null", QueryOptions{})
		if err != nil || rs[0].Rows[0][0] != true {
			t.Fatalf("table was created: %v %v", rs, err)
		}
	})

	t.Run("read-only can read", func(t *testing.T) {
		rs, err := run("select current_setting('transaction_read_only')", QueryOptions{ReadOnly: true})
		if err != nil || rs[0].Rows[0][0] != "on" {
			t.Fatalf("%v %v", rs, err)
		}
	})

	t.Run("parameters", func(t *testing.T) {
		v := "it's"
		rs, err := run("select $1::text as s, $2::int as n", QueryOptions{Params: []*string{&v, nil}})
		if err != nil || rs[0].Rows[0][0] != "it's" || rs[0].Rows[0][1] != nil {
			t.Fatalf("%v %v", rs, err)
		}
	})

	t.Run("session state does not leak between runs", func(t *testing.T) {
		// Fill the pool so later runs reuse these connections.
		for i := 0; i < 6; i++ {
			if _, err := run("set search_path = leaked; set application_name = 'leaked'; begin", QueryOptions{}); err != nil {
				t.Fatal(err)
			}
		}
		for i := 0; i < 6; i++ {
			rs, err := run("select current_setting('search_path'), current_setting('application_name'), now() = statement_timestamp()", QueryOptions{})
			if err != nil {
				t.Fatal(err)
			}
			row := rs[0].Rows[0]
			if row[0] == "leaked" || row[1] == "leaked" {
				t.Fatalf("leaked state: %v", row)
			}
		}
	})

	t.Run("notices", func(t *testing.T) {
		rs, err := run("do $$ begin raise notice 'hello'; end $$", QueryOptions{})
		if err != nil || len(rs[0].Notices) != 1 || rs[0].Notices[0] != "NOTICE: hello" {
			t.Fatalf("%+v %v", rs, err)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		_, err := run("select pg_sleep(2)", QueryOptions{Timeout: 200 * time.Millisecond})
		var qe *QueryError
		if !errors.As(err, &qe) || qe.Code != "57014" {
			t.Fatalf("err = %#v", err)
		}
	})
}
