package advisors

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestDiff(t *testing.T) {
	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	before := Snapshot{Objects: map[string]map[string]json.RawMessage{
		"roles":    {"anon": raw(`{"login": false}`), "old": raw(`{}`)},
		"triggers": {"t": raw(`{"a": 1, "b": 2}`)},
	}, Skipped: map[string]string{"cron_jobs": "not there"}}
	after := Snapshot{Objects: map[string]map[string]json.RawMessage{
		"roles":     {"anon": raw(`{"login": true}`), "evil": raw(`{"superuser": true}`)},
		"triggers":  {"t": raw(`{"b":2,"a":1}`)}, // same, other order
		"cron_jobs": {},
	}}
	got := map[string]CategoryDiff{}
	for _, d := range Diff(before, after) {
		got[d.Name] = d
	}
	r := got["roles"]
	if len(r.Added) != 1 || r.Added[0].Key != "evil" || len(r.Removed) != 1 || r.Removed[0].Key != "old" ||
		len(r.Changed) != 1 || r.Changed[0].Key != "anon" {
		t.Errorf("roles = %+v", r)
	}
	if tr := got["triggers"]; len(tr.Added)+len(tr.Removed)+len(tr.Changed) != 0 {
		t.Errorf("triggers = %+v", tr)
	}
	if c := got["cron_jobs"]; c.Skipped == "" {
		t.Errorf("cron jobs = %+v", c)
	}
	if e := got["event_triggers"]; e.Skipped == "" {
		t.Errorf("a category the snapshot lacks = %+v", e)
	}
	if Same(before, after) || !Same(after, after) {
		t.Error("Same")
	}
}

// Takes snapshots of a real Supabase database (SUPERMIXER_TEST_SUPABASE_DB_URL)
// and finds objects added between them.
func TestSnapshotsFindChanges(t *testing.T) {
	url := os.Getenv("SUPERMIXER_TEST_SUPABASE_DB_URL")
	if url == "" {
		t.Skip("SUPERMIXER_TEST_SUPABASE_DB_URL isn't set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	c, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Skipf("no test Postgres (%v)", err)
	}
	defer c.Close(context.Background())
	run := func(ctx context.Context, sql string) ([]byte, error) {
		var out []byte
		err := c.QueryRow(ctx, sql).Scan(&out)
		return out, err
	}
	cleanup := func() {
		_, _ = c.Exec(context.Background(), `drop schema if exists snapshot_probe cascade; drop role if exists snapshot_probe_role`)
	}
	cleanup()
	t.Cleanup(cleanup)

	before, err := Take(ctx, run, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Objects["roles"]) == 0 || before.Objects["roles"]["anon"] == nil {
		t.Fatalf("roles = %v", before.Objects["roles"])
	}
	for _, sql := range []string{
		`create schema snapshot_probe`,
		`create table snapshot_probe.t (id int)`,
		`create function snapshot_probe.f() returns trigger language plpgsql security definer as $$ begin return new; end $$`,
		`create trigger probe_trigger before insert on snapshot_probe.t for each row execute function snapshot_probe.f()`,
		`create role snapshot_probe_role nologin`,
	} {
		if _, err := c.Exec(ctx, sql); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	after, err := Take(ctx, run, false)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]string{}
	for _, d := range Diff(before, after) {
		for _, a := range d.Added {
			found[d.Name+" "+a.Key] = "added"
		}
	}
	for _, want := range []string{"roles snapshot_probe_role", "security_definer_functions snapshot_probe.f()",
		"triggers snapshot_probe.t: probe_trigger"} {
		if found[want] == "" {
			t.Errorf("%s wasn't found added (found %v)", want, found)
		}
	}
	if len(found) != 3 {
		t.Errorf("found more than was added: %v", found)
	}
}
