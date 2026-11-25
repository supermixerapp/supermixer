package httpapi

import (
	"strings"
	"testing"
	"time"
)

func TestSignUp(t *testing.T) {
	// Turning it on needs email.
	{
		env := newTestEnv(t)
		admin := env.client(t)
		admin.signIn("admin", adminPassword)
		var refused struct{ Message string }
		if s := admin.do("PUT", "/admin/sign-up", map[string]any{"enabled": true, "allowed_domains": []string{}, "notify_admins": true, "require_approval": false}, &refused); s != 409 ||
			!strings.Contains(refused.Message, "email") {
			t.Fatalf("turning on without email: %d %+v", s, refused)
		}
	}

	mailer := &recordingMailer{}
	env := newTestEnvDeps(t, testDatabase(t), nil, func(d *Deps) { d.Mailer = mailer })
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	visitor := env.client(t)

	type uiConfig struct {
		SignUp bool `json:"sign_up_enabled"`
	}
	var ui uiConfig
	visitor.must(200, "GET", "/ui-config", nil, &ui)
	if ui.SignUp {
		t.Fatal("sign-up is on by default")
	}
	visitor.must(404, "POST", "/auth/sign-up", map[string]string{"email": "new@example.com"}, nil)

	type settings struct {
		Enabled         bool     `json:"enabled"`
		AllowedDomains  []string `json:"allowed_domains"`
		NotifyAdmins    bool     `json:"notify_admins"`
		RequireApproval bool     `json:"require_approval"`
	}
	var s settings
	admin.must(200, "GET", "/admin/sign-up", nil, &s)
	if s.Enabled || !s.NotifyAdmins || s.RequireApproval || len(s.AllowedDomains) != 0 {
		t.Fatalf("defaults = %+v", s)
	}
	admin.must(400, "PUT", "/admin/sign-up", settings{Enabled: true, AllowedDomains: []string{"not a domain"}, NotifyAdmins: true}, nil)
	admin.must(200, "PUT", "/admin/sign-up", settings{Enabled: true, AllowedDomains: []string{" Example.com", "@example.org", "example.com"}, NotifyAdmins: true}, &s)
	if strings.Join(s.AllowedDomains, ",") != "example.com,example.org" {
		t.Fatalf("domains = %v", s.AllowedDomains)
	}
	visitor.must(401, "GET", "/admin/sign-up", nil, nil)
	visitor.must(200, "GET", "/ui-config", nil, &ui)
	if !ui.SignUp {
		t.Fatal("ui-config doesn't say sign-up is open")
	}
	// The instance admin's address, for the emails about new accounts.
	var me struct{ ID string }
	admin.must(200, "GET", "/profile", nil, &me)
	admin.must(200, "PATCH", "/admin/users/"+me.ID, map[string]any{"email": "boss@example.com"}, nil)

	signUpLink := func(email string) string {
		t.Helper()
		m := mailer.waitFor(t, email, "Create your Supermixer account")
		match := tokenRe.FindStringSubmatch(m.Text)
		if match == nil || !strings.Contains(m.Text, "/sign-up?token=") {
			t.Fatalf("no sign-up link in:\n%s", m.Text)
		}
		return match[1]
	}

	// 1. An address outside the allowed domains is refused, and says why.
	var refused struct{ Message string }
	if st := visitor.do("POST", "/auth/sign-up", map[string]string{"email": "x@other.net"}, &refused); st != 400 ||
		!strings.Contains(refused.Message, "example.com, example.org") {
		t.Fatalf("other domain: %d %+v", st, refused)
	}

	// 2. A new address gets a link; following it makes the account and signs in.
	visitor.must(202, "POST", "/auth/sign-up", map[string]string{"email": "New@Example.com"}, nil)
	token := signUpLink("new@example.com")
	var info struct {
		Email            string
		ApprovalRequired bool `json:"approval_required"`
	}
	visitor.must(200, "GET", "/auth/sign-up/"+token, nil, &info)
	if info.Email != "new@example.com" || info.ApprovalRequired {
		t.Fatalf("link info = %+v", info)
	}
	visitor.must(400, "POST", "/auth/sign-up/"+token, map[string]string{"username": "newbie", "password": "short"}, nil)
	visitor.must(201, "POST", "/auth/sign-up/"+token, map[string]string{"username": "newbie", "password": "newbie-long-password", "display_name": "New Bie"}, nil)
	var profile struct{ Username, Email string }
	visitor.must(200, "GET", "/profile", nil, &profile)
	if profile.Username != "newbie" || profile.Email != "new@example.com" {
		t.Fatalf("profile = %+v", profile)
	}
	visitor.must(201, "POST", "/organizations", map[string]string{"name": "Newbie's"}, nil)
	visitor.must(410, "GET", "/auth/sign-up/"+token, nil, nil)
	visitor.must(410, "POST", "/auth/sign-up/"+token, map[string]string{"username": "again", "password": "again-long-password"}, nil)
	mailer.waitFor(t, "boss@example.com", "New Supermixer account: newbie")

	// 3. An address with an account is told so, and the answer looks the same.
	stranger := env.client(t)
	stranger.must(202, "POST", "/auth/sign-up", map[string]string{"email": "new@example.com"}, nil)
	mailer.waitFor(t, "new@example.com", "You already have a Supermixer account")

	// 4. The field people don't see: bots filling it get nothing sent.
	stranger.must(202, "POST", "/auth/sign-up", map[string]string{"email": "bot@example.com", "website": "https://spam.example"}, nil)

	// 5. With approval required, a new account waits and can't sign in.
	admin.must(200, "PUT", "/admin/sign-up", settings{Enabled: true, AllowedDomains: []string{"example.com", "example.org"}, NotifyAdmins: true, RequireApproval: true}, nil)
	waiter := env.client(t)
	waiter.must(202, "POST", "/auth/sign-up", map[string]string{"email": "wait@example.com"}, nil)
	token = signUpLink("wait@example.com")
	waiter.must(200, "GET", "/auth/sign-up/"+token, nil, &info)
	if !info.ApprovalRequired {
		t.Fatal("the link doesn't say approval is required")
	}
	waiter.must(202, "POST", "/auth/sign-up/"+token, map[string]string{"username": "waiter", "password": "waiter-long-password"}, nil)
	waiter.must(401, "GET", "/profile", nil, nil)
	var pending struct{ Code, Message string }
	if st := waiter.do("POST", "/auth/sign-in", map[string]string{"username": "waiter", "password": "waiter-long-password"}, &pending); st != 403 || pending.Code != "approval_pending" {
		t.Fatalf("signing in while waiting: %d %+v", st, pending)
	}
	// A wrong password still just fails.
	waiter.must(401, "POST", "/auth/sign-in", map[string]string{"username": "waiter", "password": "not-the-password-at-all"}, nil)
	mailer.waitFor(t, "boss@example.com", "Waiting for approval: waiter")

	type user struct {
		ID              string `json:"id"`
		Username        string `json:"username"`
		WaitingApproval bool   `json:"waiting_approval"`
	}
	find := func(name string) *user {
		var users []user
		admin.must(200, "GET", "/admin/users", nil, &users)
		for i := range users {
			if users[i].Username == name {
				return &users[i]
			}
		}
		return nil
	}
	w := find("waiter")
	if w == nil || !w.WaitingApproval {
		t.Fatalf("waiter = %+v", w)
	}
	visitor.must(403, "POST", "/admin/users/"+w.ID+"/approval", nil, nil)
	// It can't sign in, so it can't count as an instance admin either.
	admin.must(409, "PATCH", "/admin/users/"+w.ID, map[string]any{"is_instance_admin": true}, nil)
	var approved user
	admin.must(200, "POST", "/admin/users/"+w.ID+"/approval", nil, &approved)
	if approved.WaitingApproval {
		t.Fatal("still waiting after approval")
	}
	mailer.waitFor(t, "wait@example.com", "Your Supermixer account is ready")
	waiter.signIn("waiter", "waiter-long-password")
	admin.must(409, "POST", "/admin/users/"+w.ID+"/approval", nil, nil)
	admin.must(409, "DELETE", "/admin/users/"+w.ID+"/approval", nil, nil) // approved accounts are disabled, not declined

	// 6. Declining deletes the account and tells them.
	nope := env.client(t)
	nope.must(202, "POST", "/auth/sign-up", map[string]string{"email": "nope@example.com"}, nil)
	nope.must(202, "POST", "/auth/sign-up/"+signUpLink("nope@example.com"), map[string]string{"username": "nope", "password": "nope-long-password"}, nil)
	n := find("nope")
	admin.must(204, "DELETE", "/admin/users/"+n.ID+"/approval", nil, nil)
	if find("nope") != nil {
		t.Fatal("declined account still listed")
	}
	mailer.waitFor(t, "nope@example.com", "Your Supermixer sign-up")

	// 7. Links stop working when their domain is no longer allowed, or
	// sign-up is turned off.
	late := env.client(t)
	late.must(202, "POST", "/auth/sign-up", map[string]string{"email": "late@example.org"}, nil)
	lateToken := signUpLink("late@example.org")
	admin.must(200, "PUT", "/admin/sign-up", settings{Enabled: true, AllowedDomains: []string{"example.com"}, NotifyAdmins: false}, nil)
	late.must(400, "GET", "/auth/sign-up/"+lateToken, nil, nil)

	// 8. A disabled account's address is told it's disabled, not to sign in.
	var newbie *user
	if newbie = find("newbie"); newbie == nil {
		t.Fatal("newbie not listed")
	}
	admin.must(200, "PATCH", "/admin/users/"+newbie.ID, map[string]any{"disabled": true}, nil)
	late.must(202, "POST", "/auth/sign-up", map[string]string{"email": "new@example.com"}, nil)
	mailer.waitFor(t, "new@example.com", "Your Supermixer account is disabled")

	// 9. Ten requests an hour from one address (eight so far).
	for _, e := range []string{"a@example.com", "b@example.com"} {
		late.must(202, "POST", "/auth/sign-up", map[string]string{"email": e}, nil)
	}
	late.must(429, "POST", "/auth/sign-up", map[string]string{"email": "d@example.com"}, nil)

	admin.must(200, "PUT", "/admin/sign-up", settings{Enabled: false, AllowedDomains: []string{}, NotifyAdmins: true}, nil)
	late.must(404, "GET", "/auth/sign-up/"+signUpLink("a@example.com"), nil, nil)

	// The bot got nothing; no admin email once they were turned off.
	time.Sleep(100 * time.Millisecond)
	mailer.mu.Lock()
	for _, m := range mailer.sent {
		if m.To[0] == "bot@example.com" {
			t.Errorf("the hidden field's request was sent %q", m.Subject)
		}
		if m.To[0] == "boss@example.com" && strings.Contains(m.Subject, "a@example.com") {
			t.Errorf("admins emailed after turning it off: %q", m.Subject)
		}
	}
	mailer.mu.Unlock()

	var audit struct {
		Entries []struct{ Action string } `json:"entries"`
	}
	admin.must(200, "GET", "/admin/audit-logs?limit=200", nil, &audit)
	seen := map[string]int{}
	for _, e := range audit.Entries {
		seen[e.Action]++
	}
	if seen["user.signed_up"] != 3 || seen["user.approved"] != 1 || seen["user.declined"] != 1 || seen["instance.sign_up_updated"] != 4 {
		t.Errorf("audit = %v", seen)
	}
}
