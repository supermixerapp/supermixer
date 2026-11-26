package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"supermixer/internal/config"
)

func chatEvent(typ, actor, target string, data map[string]any) webhookEvent {
	ev := webhookEvent{ID: 1, Type: typ, Organization: "acme", Data: json.RawMessage("{}")}
	if actor != "" {
		ev.Actor = &struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		}{"u1", actor}
	}
	ev.Target.Name = target
	if data != nil {
		ev.Data, _ = json.Marshal(data)
	}
	ref := "abcdefghijklmnopqrst"
	ev.Project = &ref
	return ev
}

func TestChatMessageWords(t *testing.T) {
	for _, tc := range []struct {
		ev   webhookEvent
		want string
	}{
		{chatEvent("project.created", "alice", "Billing", nil), "alice created project Billing"},
		{chatEvent("member.joined", "bob", "bob", nil), "bob joined the organization"},
		{chatEvent("project.logs_updated", "alice", "Billing", map[string]any{"enabled": true}), "alice turned logs on for project Billing"},
		{chatEvent("project.backup_failed", "", "Billing", map[string]any{"backup_kind": "scheduled", "error": "disk full"}), "A scheduled backup of project Billing failed"},
		{chatEvent("project.backup_failed", "", "Billing", nil), "A backup of project Billing failed"},
		{chatEvent("project.operation_failed", "alice", "Billing", map[string]any{"operation": "upgrading"}), "Upgrading project Billing failed"},
		{chatEvent("project.operation_failed", "", "Billing", map[string]any{"operation": "restoring", "recovered": true}), "Restoring project Billing didn't complete; the project is as it was before"},
		{chatEvent("project.database_role_created", "alice", "Billing", map[string]any{"role": "reporter"}), "alice created database role reporter in project Billing"},
		{chatEvent("webhook.created", "alice", "https://hooks.slack.com", map[string]any{"kind": "slack"}), "alice added chat channel https://hooks.slack.com"},
		{chatEvent("something.new", "alice", "Thing", nil), "alice: something.new (Thing)"},
		{chatEvent("project.stack_started", "", "Billing", nil), "Supermixer started project Billing"},
	} {
		m := toChatMessage(tc.ev, "Acme", "https://mixer.example.com/")
		if m.Fallback != tc.want {
			t.Errorf("%s: got %q, want %q", tc.ev.Type, m.Fallback, tc.want)
		}
	}
	// A webhook's path can be its credential: chat shows the host only.
	hookEv := chatEvent("webhook.created", "alice", "https://hooks.zapier.com/hooks/catch/123/abc", map[string]any{"kind": "webhook"})
	hookEv.Target.Type = "webhook"
	if got := toChatMessage(hookEv, "Acme", "").Fallback; got != "alice added webhook https://hooks.zapier.com" {
		t.Errorf("webhook target: %q", got)
	}

	m := toChatMessage(chatEvent("project.created", "alice", "Billing", nil), "Acme", "https://mixer.example.com/")
	if m.Link != "https://mixer.example.com/project/abcdefghijklmnopqrst" {
		t.Errorf("link = %q", m.Link)
	}
	m = toChatMessage(chatEvent("project.deleted", "alice", "Billing", nil), "Acme", "https://mixer.example.com")
	if m.Link != "https://mixer.example.com/org/acme/audit" {
		t.Errorf("deleted project's link = %q", m.Link)
	}
	if !toChatMessage(chatEvent("project.backup_failed", "", "B", nil), "Acme", "").Problem {
		t.Error("a failure isn't marked as a problem")
	}
}

// Names come from people: none of them may ping a channel, add a link or
// break out of the formatting.
func TestChatEscaping(t *testing.T) {
	evil := "<!channel> @here @all [click](https://evil.example) *x* <https://evil.example|y>"
	ev := chatEvent("project.created", evil, evil, map[string]any{})
	m := toChatMessage(ev, "Acme @channel", "https://mixer.example.com")
	text := func(kind string) string {
		b, err := chatBody(kind, m)
		if err != nil {
			t.Fatal(err)
		}
		var v map[string]any
		if err := json.Unmarshal(b, &v); err != nil {
			t.Fatal(err)
		}
		if s, ok := v["text"].(string); ok && kind != kindTeams {
			return s
		}
		if s, ok := v["content"].(string); ok {
			return s
		}
		return string(b)
	}

	// Slack: the top-level text is escaped mrkdwn; the blocks are rich text,
	// whose text elements are literal.
	b, _ := chatBody(kindSlack, m)
	var slack struct {
		Text   string
		Blocks []struct {
			Type     string
			Elements []struct {
				Type     string
				Elements []struct{ Type, Text, URL string }
			}
		}
	}
	if err := json.Unmarshal(b, &slack); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(slack.Text, "<!channel>") || strings.Contains(slack.Text, "<https://evil") || !strings.Contains(slack.Text, "&lt;!channel&gt;") {
		t.Errorf("slack text: %s", slack.Text)
	}
	if len(slack.Blocks) != 1 || slack.Blocks[0].Type != "rich_text" {
		t.Fatalf("slack blocks: %s", b)
	}
	runs := slack.Blocks[0].Elements[0].Elements
	if runs[0].Type != "text" || runs[0].Text != evil {
		t.Errorf("slack: first run = %+v", runs[0])
	}
	footer := slack.Blocks[0].Elements[len(slack.Blocks[0].Elements)-1].Elements
	if last := footer[len(footer)-1]; last.Type != "link" || !strings.HasPrefix(last.URL, "https://mixer.example.com/project/") {
		t.Errorf("slack: footer = %+v", footer)
	}
	// Google Chat has no escapes: < and > become look-alikes.
	if s := text(kindGoogleChat); strings.Contains(s, "<!channel>") || strings.Contains(s, "<https://evil") ||
		!strings.Contains(s, "‹!channel›") || !strings.Contains(s, "<https://mixer.example.com/project/") {
		t.Errorf("google chat: %s", s)
	}
	for _, kind := range []string{kindDiscord, kindMattermost} {
		s := text(kind)
		if strings.Contains(s, "](https://evil") || strings.Contains(s, "@here") || strings.Contains(s, "@all") || strings.Contains(s, "@channel") {
			t.Errorf("%s: unescaped: %s", kind, s)
		}
		if !strings.Contains(s, "[Open in Supermixer](https://mixer.example.com/project/") {
			t.Errorf("%s: no link: %s", kind, s)
		}
	}
	b, _ = chatBody(kindDiscord, m)
	if !strings.Contains(string(b), `"allowed_mentions":{"parse":[]}`) {
		t.Errorf("discord: mentions allowed: %s", b)
	}
	// Teams: TextRuns aren't Markdown; the name is there as written.
	b, _ = chatBody(kindTeams, m)
	var card struct {
		Attachments []struct {
			Content struct {
				Body []struct {
					Inlines []struct{ Text, Weight string }
				}
				Actions []struct{ Type, URL string }
			}
		}
	}
	if err := json.Unmarshal(b, &card); err != nil || len(card.Attachments) != 1 {
		t.Fatalf("teams: %v %s", err, b)
	}
	c := card.Attachments[0].Content
	if c.Body[0].Inlines[0].Text != evil || c.Body[0].Inlines[0].Weight != "bolder" {
		t.Errorf("teams: first run = %+v", c.Body[0].Inlines[0])
	}
	if len(c.Actions) != 1 || c.Actions[0].Type != "Action.OpenUrl" {
		t.Errorf("teams: actions = %+v", c.Actions)
	}
}

// chatSink is a chat app's incoming webhook.
type chatSink struct {
	mu     sync.Mutex
	bodies []map[string]any
	paths  []string
}

func (s *chatSink) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := io.ReadAll(r.Body)
	var v map[string]any
	_ = json.Unmarshal(b, &v)
	if r.Header.Get("X-Supermixer-Signature") != "" {
		http.Error(w, "chat apps get no signature", http.StatusBadRequest)
		return
	}
	s.bodies = append(s.bodies, v)
	s.paths = append(s.paths, r.URL.RequestURI())
}

// texts is each message as JSON (Slack's text plus its blocks).
func (s *chatSink) texts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, b := range s.bodies {
		j, _ := json.Marshal(b)
		out = append(out, string(j))
	}
	return out
}

func TestChatChannels(t *testing.T) {
	old := webhookPoll
	webhookPoll = 50 * time.Millisecond
	t.Cleanup(func() { webhookPoll = old })
	sink := &chatSink{}
	srv := httptest.NewServer(sink)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	env := newTestEnvDeps(t, testDatabase(t), func(c *config.Config) { c.Webhooks.AllowPrivateAddresses = true },
		func(d *Deps) { d.Background = ctx })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Chatty"}, nil)
	base := "/organizations/chatty/webhooks"
	address := srv.URL + "/services/T000/B000/s3cr3tt0ken"

	admin.must(400, "POST", base, map[string]any{"kind": "irc", "url": address, "events": []string{"member."}}, nil)
	admin.must(400, "POST", base, map[string]any{"kind": "slack", "url": srv.URL + "/", "events": []string{"member."}}, nil) // a host isn't an incoming webhook
	var created struct {
		Webhook struct{ ID, URL, Kind string }
		Secret  string
	}
	admin.must(201, "POST", base, map[string]any{"kind": "slack", "url": address, "events": []string{"member."}}, &created)
	// The address is the credential: never returned, nor in the audit log.
	if created.Secret != "" || created.Webhook.Kind != "slack" || strings.Contains(created.Webhook.URL, "s3cr3t") || created.Webhook.URL != srv.URL {
		t.Fatalf("created = %+v", created)
	}
	hook := base + "/" + created.Webhook.ID
	admin.must(400, "POST", hook+"/secret", nil, nil)

	var list []struct{ URL string }
	admin.must(200, "GET", base, nil, &list)
	var audit struct {
		Entries []map[string]any
	}
	admin.must(200, "GET", "/organizations/chatty/audit-logs", nil, &audit)
	for _, s := range []any{list, audit} {
		b, _ := json.Marshal(s)
		if strings.Contains(string(b), "s3cr3t") {
			t.Fatalf("the address leaked: %s", b)
		}
	}

	// A test message, then real events, to the full address.
	var d struct {
		Status int
		Error  string
	}
	admin.must(200, "POST", hook+"/test", nil, &d)
	if d.Status != 200 || d.Error != "" {
		t.Fatalf("test = %+v", d)
	}
	joinAs(t, env, admin, "chatty", "carl", "developer")
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(25 * time.Millisecond) {
		if strings.Contains(strings.Join(sink.texts(), "\n"), `"text":"carl joined the organization"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no join message; got %q", sink.texts())
		}
	}
	sink.mu.Lock()
	for _, p := range sink.paths {
		if p != "/services/T000/B000/s3cr3tt0ken" {
			t.Errorf("posted to %q", p)
		}
	}
	sink.mu.Unlock()
	if !strings.Contains(sink.texts()[0], "sent a test message") || !strings.Contains(sink.texts()[0], "Chatty") {
		t.Errorf("test message = %q", sink.texts()[0])
	}

	// Saving with the shown host (or nothing) keeps the address; a new one
	// replaces it.
	admin.must(200, "PATCH", hook, map[string]any{"url": srv.URL, "description": "ops"}, nil)
	admin.must(200, "PATCH", hook, map[string]any{"url": ""}, nil)
	admin.must(200, "PATCH", hook, map[string]any{"url": srv.URL + "/"}, nil)
	admin.must(400, "PATCH", hook, map[string]any{"url": "https://elsewhere.example.com"}, nil)
	admin.must(200, "POST", hook+"/test", nil, &d)
	admin.must(200, "PATCH", hook, map[string]any{"url": srv.URL + "/services/new"}, nil)
	admin.must(200, "POST", hook+"/test", nil, &d)
	sink.mu.Lock()
	paths := sink.paths
	sink.mu.Unlock()
	if n := len(paths); n < 2 || paths[n-2] != "/services/T000/B000/s3cr3tt0ken" || paths[n-1] != "/services/new" {
		t.Fatalf("paths = %v", paths)
	}

	// Webhooks and chat channels each have their own limit.
	for i := 0; i < maxWebhooksPerOrg; i++ {
		admin.must(201, "POST", base, map[string]any{"url": srv.URL + "/hook", "events": []string{"project."}}, nil)
	}
	admin.must(409, "POST", base, map[string]any{"url": srv.URL + "/hook", "events": []string{"project."}}, nil)
	admin.must(201, "POST", base, map[string]any{"kind": "discord", "url": address, "events": []string{"member."}}, nil)

	// The summary for Organization › Integrations.
	var sum struct {
		Chat, Webhooks struct{ Total, Failing int }
		BackupCopies   struct{ Enabled bool } `json:"backup_copies"`
	}
	dev := joinAs(t, env, admin, "chatty", "dev", "developer")
	dev.must(200, "GET", "/organizations/chatty/integrations", nil, &sum)
	if sum.Chat.Total != 2 || sum.Webhooks.Total != maxWebhooksPerOrg || sum.BackupCopies.Enabled {
		t.Fatalf("summary = %+v", sum)
	}
}
