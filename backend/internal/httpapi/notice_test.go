package httpapi

import (
	"strings"
	"testing"
)

func TestGlobalNotice(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Notices"}, nil)
	member := joinAs(t, env, admin, "notices", "noticereader", "read_only")

	type notice struct {
		Type, Message string
		PostedBy      string `json:"posted_by"`
		PostedAt      string `json:"posted_at"`
	}
	var state struct{ Notice *notice }
	member.must(200, "GET", "/notice", nil, &state)
	if state.Notice != nil {
		t.Fatalf("a notice before any: %+v", state.Notice)
	}

	// Only instance admins post; the message is one line, at most 256 characters.
	member.must(403, "PUT", "/admin/notice", map[string]string{"type": "info", "message": "hi"}, nil)
	admin.must(400, "PUT", "/admin/notice", map[string]string{"type": "fatal", "message": "hi"}, nil)
	admin.must(400, "PUT", "/admin/notice", map[string]string{"type": "info", "message": " \n "}, nil)
	admin.must(400, "PUT", "/admin/notice", map[string]string{"type": "info", "message": strings.Repeat("é", 257)}, nil)
	admin.must(200, "PUT", "/admin/notice", map[string]string{"type": "info", "message": strings.Repeat("é", 256)}, nil)

	// Markdown links: only where the band would follow them.
	for _, bad := range []string{"[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](//evil.example)", `[x](/\evil.example)`, "[x](https:nohost)"} {
		admin.must(400, "PUT", "/admin/notice", map[string]string{"type": "info", "message": "See " + bad}, nil)
	}
	admin.must(200, "PUT", "/admin/notice", map[string]string{"type": "info",
		"message": "**Down** tonight: [status](https://status.example.com), [ask](mailto:ops@example.com), [your account](/account/security)"}, nil)
	var posted notice
	admin.must(200, "PUT", "/admin/notice", map[string]string{"type": "warning", "message": "  Upgrading tonight,\n22:00–23:00 UTC.  "}, &posted)
	if posted.Type != "warning" || posted.Message != "Upgrading tonight, 22:00–23:00 UTC." || posted.PostedBy != "admin" || posted.PostedAt == "" {
		t.Fatalf("posted = %+v", posted)
	}

	// Everyone signed in sees it; nobody else.
	member.must(200, "GET", "/notice", nil, &state)
	if state.Notice == nil || *state.Notice != posted {
		t.Fatalf("member sees %+v", state.Notice)
	}
	env.client(t).must(401, "GET", "/notice", nil, nil)

	member.must(403, "DELETE", "/admin/notice", nil, nil)
	admin.must(204, "DELETE", "/admin/notice", nil, nil)
	admin.must(204, "DELETE", "/admin/notice", nil, nil) // already gone
	member.must(200, "GET", "/notice", nil, &state)
	if state.Notice != nil {
		t.Fatalf("after taking it down: %+v", state.Notice)
	}

	var audit struct {
		Entries []struct{ Action string } `json:"entries"`
	}
	admin.must(200, "GET", "/admin/audit-logs?action=instance.notice", nil, &audit)
	count := map[string]int{}
	for _, e := range audit.Entries {
		count[e.Action]++
	}
	if count["instance.notice_posted"] != 3 || count["instance.notice_removed"] != 1 {
		t.Errorf("audit = %v", count)
	}
}
