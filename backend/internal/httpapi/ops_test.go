package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/metrics"
	"supermixer/internal/store"
)

// Two replicas on one database: one does the background work, and the
// other takes over when it stops or loses its connection.
func TestLeader(t *testing.T) {
	dbURL := testDatabase(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	var active atomic.Int32 // which replica is working (0: none)
	var overlap atomic.Bool
	replica := func(n int32) context.CancelFunc {
		st, err := store.Open(context.Background(), dbURL, 2, logger)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			st.RunAsLeader(ctx, logger, 50*time.Millisecond, func(ctx context.Context) {
				if !active.CompareAndSwap(0, n) {
					overlap.Store(true)
				}
				<-ctx.Done()
				active.CompareAndSwap(n, 0)
			})
		}()
		t.Cleanup(func() { cancel(); <-done; st.Close() })
		return cancel
	}
	waitActive := func(want ...int32) int32 {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			a := active.Load()
			for _, w := range want {
				if a == w {
					return a
				}
			}
		}
		t.Fatalf("working: %d, want one of %v", active.Load(), want)
		return 0
	}
	stop := map[int32]context.CancelFunc{1: replica(1), 2: replica(2)}
	first := waitActive(1, 2)
	time.Sleep(300 * time.Millisecond)
	if active.Load() != first || overlap.Load() {
		t.Fatalf("the work moved or overlapped")
	}
	// The leader stops: the other takes over.
	other := 3 - first
	stop[first]()
	waitActive(other)

	// A third replica; then the leader's connection is cut.
	replica(3)
	time.Sleep(200 * time.Millisecond)
	if active.Load() != other {
		t.Fatalf("a new replica took over from a working leader")
	}
	conn := openTestDB(t, dbURL)
	if _, err := conn.Exec(context.Background(), `select pg_terminate_backend(pid) from pg_locks
		where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`); err != nil {
		t.Fatal(err)
	}
	waitActive(3)
	if overlap.Load() {
		t.Fatal("two replicas worked at once")
	}
}

type drainSink struct {
	mu      sync.Mutex
	entries []drainEntry
	fail    int // answer 503 this many more times
	tries   int
}

func (s *drainSink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer drain-token" {
		http.Error(w, "who are you", http.StatusUnauthorized)
		return
	}
	s.tries++
	if s.fail > 0 {
		s.fail--
		http.Error(w, "down for maintenance", http.StatusServiceUnavailable)
		return
	}
	var batch []drainEntry
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	s.entries = append(s.entries, batch...)
}

func (s *drainSink) actions() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var a []string
	for _, e := range s.entries {
		a = append(a, e.Action+":"+e.Target.Name)
	}
	return a
}

func TestAuditDrains(t *testing.T) {
	old := drainPoll
	drainPoll = 50 * time.Millisecond
	t.Cleanup(func() { drainPoll = old })

	sink := &drainSink{}
	sinkSrv := httptest.NewServer(sink)
	t.Cleanup(sinkSrv.Close)
	file := filepath.Join(t.TempDir(), "audit.jsonl")
	dbURL := testDatabase(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	env := newTestEnvDeps(t, dbURL, func(c *config.Config) {
		c.Audit.Drains = []config.AuditDrain{
			{ID: "siem", Type: "http", URL: sinkSrv.URL, Headers: map[string]string{"Authorization": "Bearer drain-token"}},
			{ID: "file", Type: "file", Path: file},
		}
	}, func(d *Deps) { d.Background = ctx })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Drained"}, nil)
	waitUntil := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
			if ok() {
				return
			}
		}
		t.Fatalf("waiting for %s; the sink has %v", what, sink.actions())
	}
	has := func(a string) bool {
		for _, x := range sink.actions() {
			if x == a {
				return true
			}
		}
		return false
	}
	waitUntil("the new organization", func() bool { return has("organization.created:Drained") })
	sink.mu.Lock()
	e := sink.entries[len(sink.entries)-1]
	sink.mu.Unlock()
	if e.Actor == nil || e.Actor.Username != "admin" || e.Organization == nil || *e.Organization != "drained" || e.Source != "supermixer" {
		t.Fatalf("entry = %+v", e)
	}

	// An entry whose transaction is still open holds back later ones, so
	// none is skipped: then they arrive in order.
	conn := openTestDB(t, dbURL)
	tx, err := conn.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), `insert into audit_logs (action, target_name) values ('test.slow', 'first')`); err != nil {
		t.Fatal(err)
	}
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Second"}, nil)
	time.Sleep(300 * time.Millisecond)
	if has("organization.created:Second") {
		t.Fatal("delivered past an open transaction's entry")
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitUntil("both", func() bool { return has("organization.created:Second") })
	a := sink.actions()
	if a[len(a)-2] != "test.slow:first" || a[len(a)-1] != "organization.created:Second" {
		t.Fatalf("order: %v", a)
	}

	// The endpoint is down for a while: nothing is lost or repeated.
	sink.mu.Lock()
	sink.fail = 2
	sink.mu.Unlock()
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Third"}, nil)
	waitUntil("after the outage", func() bool { return has("organization.created:Third") })
	seen := map[int64]bool{}
	sink.mu.Lock()
	for _, e := range sink.entries {
		if seen[e.ID] {
			t.Errorf("entry %d delivered twice", e.ID)
		}
		seen[e.ID] = true
	}
	sink.mu.Unlock()
	var lastErr string
	if err := conn.QueryRow(context.Background(), `select last_error from audit_drains where id = 'siem'`).Scan(&lastErr); err != nil || lastErr != "" {
		t.Fatalf("last_error after recovering = %q, %v", lastErr, err)
	}

	// While backing off, new entries don't hurry a retry.
	sink.mu.Lock()
	sink.fail, sink.tries = 1000, 0
	sink.mu.Unlock()
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Backoff"}, nil)
	time.Sleep(200 * time.Millisecond) // the first try fails: next in 100ms, then 200ms...
	for i := 0; i < 20; i++ {
		admin.must(200, "PATCH", "/profile", map[string]any{"display_name": fmt.Sprintf("Admin %d", i)}, nil)
	}
	time.Sleep(300 * time.Millisecond)
	sink.mu.Lock()
	tries := sink.tries
	sink.fail = 0
	sink.mu.Unlock()
	if tries > 5 {
		t.Errorf("%d tries in half a second of backing off", tries)
	}
	waitUntil("after backing off", func() bool { return has("organization.created:Backoff") })

	// The admin overview shows how drains are doing.
	var o struct {
		AuditDrains []struct {
			ID, Type, Target, LastError string
			Pending                     int64
			LastSuccessAt               *time.Time `json:"last_success_at"`
		} `json:"audit_drains"`
	}
	admin.must(200, "GET", "/admin/overview", nil, &o)
	if len(o.AuditDrains) != 2 || o.AuditDrains[0].Target != sinkSrv.URL || o.AuditDrains[0].LastSuccessAt == nil || o.AuditDrains[1].Target != file {
		t.Fatalf("overview drains = %+v", o.AuditDrains)
	}

	// The file drain has the same entries, as JSON lines.
	waitUntil("the file", func() bool {
		b, _ := os.ReadFile(file)
		return strings.Contains(string(b), `"Third"`)
	})
	f, _ := os.Open(file)
	defer f.Close()
	lines := 0
	for sc := bufio.NewScanner(f); sc.Scan(); lines++ {
		var e drainEntry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatalf("line %d: %v", lines+1, err)
		}
	}
	if lines != len(sink.actions()) {
		t.Fatalf("file has %d entries, the sink %d", lines, len(sink.actions()))
	}
}

func TestMetrics(t *testing.T) {
	var m *metrics.Metrics
	env := newTestEnvDeps(t, testDatabase(t), nil, func(d *Deps) {
		m = metrics.New(MetricsState(d.Store))
		d.Metrics = m
	})
	admin := env.client(t)
	admin.must(401, "POST", "/auth/sign-in", map[string]string{"username": "admin", "password": "nope"}, nil)
	admin.signIn("admin", adminPassword)
	admin.must(200, "GET", "/organizations", nil, nil)
	admin.must(200, "GET", "/organizations", nil, nil)
	// Made-up methods share one label.
	for _, m := range []string{"FOO1", "FOO2", "FOO3"} {
		req, _ := http.NewRequest(m, env.server.URL+"/", nil)
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
		}
	}

	srv := httptest.NewServer(m.Handler())
	t.Cleanup(srv.Close)
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, want := range []string{
		`supermixer_sign_ins_total{method="password",result="failure"} 1`,
		`supermixer_sign_ins_total{method="password",result="success"} 1`,
		`supermixer_http_requests_total{code="200",method="GET",route="/api/v1/organizations"} 2`,
		`supermixer_users{state="active"} 1`,
		`supermixer_stacks{status="running"} 0`,
		`supermixer_state_up 1`,
		`method="other",route="static"} 3`,
		`supermixer_build_info{version=`,
	} {
		if !strings.Contains(string(body), want) {
			t.Errorf("no %s in\n%s", want, grepLines(string(body), "supermixer_"))
		}
	}
}

func grepLines(s, sub string) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if strings.Contains(l, sub) && !strings.HasPrefix(l, "#") {
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

// Delivery errors are logged and shown to admins: no tokens in them.
func TestDrainErrorsHideSecrets(t *testing.T) {
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "no", 503) }))
	t.Cleanup(down.Close)
	for _, base := range []string{closed.URL, down.URL} {
		u := strings.Replace(base, "http://", "http://user:pw-secret@", 1) + "/in?token=q-secret#f"
		err := deliver(context.Background(), config.AuditDrain{ID: "x", Type: "http", URL: u}, []drainEntry{{ID: 1}})
		if err == nil || strings.Contains(err.Error(), "secret") || !strings.Contains(err.Error(), "/in") {
			t.Errorf("error = %v", err)
		}
	}
}

// A redirect isn't delivery: following it would drop the entries.
func TestDrainRedirectFails(t *testing.T) {
	got := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got++ }))
	t.Cleanup(target.Close)
	moved := httptest.NewServer(http.RedirectHandler(target.URL+"/in", http.StatusMovedPermanently))
	t.Cleanup(moved.Close)
	err := deliver(context.Background(), config.AuditDrain{ID: "x", Type: "http", URL: moved.URL}, []drainEntry{{ID: 1}})
	if err == nil || !strings.Contains(err.Error(), "redirect") || got != 0 {
		t.Fatalf("err = %v, target got %d requests", err, got)
	}
}

// A drain whose database row can't be made at first starts once it can,
// and until then shows as not started.
func TestDrainStartsLate(t *testing.T) {
	old := drainPoll
	drainPoll = 20 * time.Millisecond
	t.Cleanup(func() { drainPoll = old })
	file := filepath.Join(t.TempDir(), "audit.jsonl")
	dbURL := testDatabase(t)
	conn := openTestDB(t, dbURL)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	env := newTestEnvDeps(t, dbURL, func(c *config.Config) {
		c.Audit.Drains = []config.AuditDrain{{ID: "late", Type: "file", Path: file}}
	}, func(d *Deps) { d.Background = ctx })
	// Take the table away before the drain first runs.
	if _, err := conn.Exec(context.Background(), `alter table audit_drains rename to audit_drains_away`); err != nil {
		t.Fatal(err)
	}
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	var o struct {
		AuditDrains []struct{ State string } `json:"audit_drains"`
	}
	admin.must(200, "GET", "/admin/overview", nil, &o)
	if len(o.AuditDrains) != 1 || o.AuditDrains[0].State != "unknown" {
		t.Fatalf("drains = %+v", o.AuditDrains)
	}
	time.Sleep(100 * time.Millisecond)
	if _, err := conn.Exec(context.Background(), `alter table audit_drains_away rename to audit_drains`); err != nil {
		t.Fatal(err)
	}
	// It starts on a retry (and, being new, with entries written after).
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(25 * time.Millisecond) {
		admin.must(200, "GET", "/admin/overview", nil, &o)
		if o.AuditDrains[0].State == "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("still %s", o.AuditDrains[0].State)
		}
	}
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Late"}, nil)
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(25 * time.Millisecond) {
		if b, _ := os.ReadFile(file); strings.Contains(string(b), `"Late"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the drain never started")
		}
	}
}
