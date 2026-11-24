package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"supermixer/internal/config"
)

// webhookSink receives webhooks and checks their signatures.
type webhookSink struct {
	t      *testing.T
	mu     sync.Mutex
	secret string
	events []webhookEvent
	fail   int // answer 500 this many more times
	tries  int
}

func (s *webhookSink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tries++
	body, _ := io.ReadAll(r.Body)
	var ts int64
	var sig string
	for _, part := range strings.Split(r.Header.Get("X-Supermixer-Signature"), ",") {
		k, v, _ := strings.Cut(part, "=")
		switch k {
		case "t":
			ts, _ = strconv.ParseInt(v, 10, 64)
		case "v1":
			sig = v
		}
	}
	if sig == "" || sig != signWebhook(s.secret, ts, body) || time.Since(time.Unix(ts, 0)) > time.Minute {
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	if s.fail > 0 {
		s.fail--
		http.Error(w, "busy", http.StatusInternalServerError)
		return
	}
	var e webhookEvent
	if err := json.Unmarshal(body, &e); err != nil || r.Header.Get("X-Supermixer-Event") != e.Type {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	s.events = append(s.events, e)
}

func (s *webhookSink) types() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, e := range s.events {
		out = append(out, e.Type+":"+e.Target.Name)
	}
	return out
}

func TestWebhooks(t *testing.T) {
	old := webhookPoll
	webhookPoll = 50 * time.Millisecond
	t.Cleanup(func() { webhookPoll = old })
	sink := &webhookSink{t: t}
	srv := httptest.NewServer(sink)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	env := newTestEnvDeps(t, testDatabase(t), func(c *config.Config) { c.Webhooks.AllowPrivateAddresses = true },
		func(d *Deps) { d.Background = ctx })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Hooked"}, nil)
	dev := joinAs(t, env, admin, "hooked", "dev", "administrator")
	base := "/organizations/hooked/webhooks"

	// Owners only: they send the organization's events outside.
	dev.must(403, "GET", base, nil, nil)
	admin.must(400, "POST", base, map[string]any{"url": "ftp://x", "events": []string{"member."}}, nil)
	admin.must(400, "POST", base, map[string]any{"url": srv.URL, "events": []string{}}, nil)
	var created struct {
		Webhook struct{ ID, URL string }
		Secret  string
	}
	admin.must(201, "POST", base, map[string]any{"url": srv.URL, "events": []string{"member.", "invitation."}}, &created)
	if !strings.HasPrefix(created.Secret, "whsec_") {
		t.Fatalf("secret = %q", created.Secret)
	}
	sink.mu.Lock()
	sink.secret = created.Secret
	sink.mu.Unlock()
	hook := base + "/" + created.Webhook.ID

	wait := func(what string, ok func([]string) bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
			if ok(sink.types()) {
				return
			}
		}
		t.Fatalf("waiting for %s; got %v", what, sink.types())
	}
	has := func(want string) func([]string) bool {
		return func(got []string) bool { return strings.Contains(strings.Join(got, " "), want) }
	}

	// Chosen events only, from when it was added (dev joining came before).
	admin.must(200, "PATCH", "/organizations/hooked", map[string]any{"name": "Hooked Inc"}, nil) // organization.: not chosen
	joinAs(t, env, admin, "hooked", "carl", "developer")                                         // invitation.created, member.joined
	wait("carl joining", has("member.joined:carl"))
	got := sink.types()
	if strings.Contains(strings.Join(got, " "), "organization.") || strings.Contains(strings.Join(got, " "), ":dev") {
		t.Fatalf("unwanted events: %v", got)
	}
	sink.mu.Lock()
	e := sink.events[len(sink.events)-1]
	sink.mu.Unlock()
	if e.Organization != "hooked" || e.Actor == nil || e.Actor.Username != "carl" || e.ID == 0 {
		t.Fatalf("event = %+v", e)
	}

	// A failing receiver holds events back, in order, and gets them later.
	sink.mu.Lock()
	sink.fail = 2
	sink.mu.Unlock()
	joinAs(t, env, admin, "hooked", "dora", "developer")
	joinAs(t, env, admin, "hooked", "eddie", "developer")
	wait("after failures", has("member.joined:eddie"))
	got = sink.types()
	if i, j := strings.Index(strings.Join(got, " "), "member.joined:dora"), strings.Index(strings.Join(got, " "), "member.joined:eddie"); i < 0 || i > j {
		t.Fatalf("order: %v", got)
	}
	seen := map[int64]bool{}
	sink.mu.Lock()
	for _, e := range sink.events {
		if seen[e.ID] {
			t.Errorf("event %d sent twice", e.ID)
		}
		seen[e.ID] = true
	}
	sink.mu.Unlock()
	var deliveries []struct {
		Status int
		Error  string
		Event  string
	}
	admin.must(200, "GET", hook+"/deliveries", nil, &deliveries)
	failed := 0
	for _, d := range deliveries {
		if d.Status == 500 && d.Error != "" {
			failed++
		}
	}
	if failed != 2 {
		t.Fatalf("deliveries = %+v", deliveries)
	}

	// A test event, now.
	var test struct {
		Status int
		Event  string
	}
	admin.must(200, "POST", hook+"/test", nil, &test)
	if test.Status != 200 || test.Event != "webhook.test" {
		t.Fatalf("test = %+v", test)
	}

	// A new secret: the old one no longer signs.
	var rotated struct{ Secret string }
	admin.must(200, "POST", hook+"/secret", nil, &rotated)
	admin.must(200, "POST", hook+"/test", nil, &test)
	if test.Status != 401 {
		t.Fatalf("with the old secret, the receiver answered %d", test.Status)
	}
	sink.mu.Lock()
	sink.secret = rotated.Secret
	sink.mu.Unlock()

	// Off: nothing sent, and turning it on doesn't send what it missed.
	admin.must(200, "PATCH", hook, map[string]any{"enabled": false}, nil)
	joinAs(t, env, admin, "hooked", "fay", "developer")
	time.Sleep(300 * time.Millisecond)
	admin.must(200, "PATCH", hook, map[string]any{"enabled": true}, nil)
	joinAs(t, env, admin, "hooked", "gus", "developer")
	wait("after turning it on", has("member.joined:gus"))
	if has("fay")(sink.types()) {
		t.Fatal("sent an event from while it was off")
	}

	// Recorded in the organization's audit log, without the URL's secrets.
	var audit struct{ Entries []struct{ Action string } }
	admin.must(200, "GET", "/organizations/hooked/audit-logs?action=webhook.", nil, &audit)
	if len(audit.Entries) < 3 {
		t.Fatalf("audit = %+v", audit.Entries)
	}
	admin.must(204, "DELETE", hook, nil, nil)
	admin.must(404, "POST", hook+"/test", nil, nil)
}

// Without webhooks.allow_private_addresses, webhooks can't reach inside.
func TestWebhookPrivateAddresses(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Probe"}, nil)
	for _, u := range []string{"http://127.0.0.1:5432/", "http://localhost/", "http://10.1.2.3/", "http://[::1]/", "http://169.254.169.254/latest/meta-data"} {
		admin.must(400, "POST", "/organizations/probe/webhooks", map[string]any{"url": u, "events": []string{"*"}}, nil)
	}
	// A public-looking name that resolves inside is refused when connecting.
	srv := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(srv.Close)
	_, err := webhookClient(false).Get(srv.URL)
	if err == nil || !strings.Contains(err.Error(), "private or local address") {
		t.Fatalf("err = %v", err)
	}
}
