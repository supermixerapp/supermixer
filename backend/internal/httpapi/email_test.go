package httpapi

import (
	"context"
	"encoding/base32"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"supermixer/internal/auth"
	"supermixer/internal/mail"
)

type recordingMailer struct {
	mu   sync.Mutex
	sent []mail.Message
}

func (r *recordingMailer) Send(_ context.Context, m mail.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, m)
	return nil
}

func (r *recordingMailer) From() string { return "Supermixer <sm@example.com>" }

// waitFor returns the first message to and about subject, waiting for
// emails sent in the background.
func (r *recordingMailer) waitFor(t *testing.T, to, subject string) mail.Message {
	t.Helper()
	for i := 0; i < 100; i++ {
		r.mu.Lock()
		for _, m := range r.sent {
			if m.To[0] == to && strings.Contains(m.Subject, subject) {
				r.mu.Unlock()
				return m
			}
		}
		r.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no email to %s about %q", to, subject)
	return mail.Message{}
}

func (r *recordingMailer) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sent)
}

var tokenRe = regexp.MustCompile(`token=([A-Za-z0-9_-]+)`)

func TestEmail(t *testing.T) {
	mailer := &recordingMailer{}
	env := newTestEnvDeps(t, testDatabase(t), nil, func(d *Deps) { d.Mailer = mailer })
	admin := env.client(t)
	admin.signIn("admin", "admin")
	var ui struct {
		EmailEnabled bool `json:"email_enabled"`
	}
	env.client(t).must(200, "GET", "/ui-config", nil, &ui)
	if !ui.EmailEnabled {
		t.Fatal("email_enabled is false")
	}

	// A test email goes to your own address.
	admin.must(400, "POST", "/admin/email/test", nil, nil)
	admin.must(200, "PATCH", "/profile", map[string]any{"email": "admin@example.com"}, nil)
	admin.must(200, "POST", "/admin/email/test", nil, nil)
	if m := mailer.waitFor(t, "admin@example.com", "email works"); !strings.Contains(m.HTML, "<!doctype html>") {
		t.Errorf("test email = %+v", m)
	}

	// Invitations with an address are emailed.
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Mailers"}, nil)
	var inv struct {
		URL       string `json:"url"`
		EmailSent bool   `json:"email_sent"`
	}
	admin.must(201, "POST", "/organizations/mailers/invitations", map[string]any{"role": "developer", "email": "New@Example.com"}, &inv)
	m := mailer.waitFor(t, "new@example.com", "invited you to Mailers")
	if !inv.EmailSent || !strings.Contains(m.Text, inv.URL) || !strings.Contains(m.Text, "Developer") {
		t.Fatalf("invitation %+v, email %q", inv, m.Text)
	}

	// Forgot your password: the same answer whether or not there's such an account.
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "carol", "password": "carol-old-pass", "email": "carol@example.com", "require_password_change": false}, nil)
	carol := env.client(t)
	carol.signIn("carol", "carol-old-pass")
	before := mailer.count()
	anon := env.client(t)
	anon.must(202, "POST", "/auth/password-reset", map[string]string{"login": "nobody@example.com"}, nil)
	anon.must(202, "POST", "/auth/password-reset", map[string]string{"login": "Carol@example.com"}, nil)
	m = mailer.waitFor(t, "carol@example.com", "Reset your Supermixer password")
	if mailer.count() != before+1 {
		t.Errorf("%d emails for one account", mailer.count()-before)
	}
	token := tokenRe.FindStringSubmatch(m.Text)[1]
	var info struct {
		Username    string `json:"username"`
		MfaRequired bool   `json:"mfa_required"`
	}
	anon.must(200, "GET", "/auth/password-reset/"+token, nil, &info)
	if info.Username != "carol" || info.MfaRequired {
		t.Fatalf("info = %+v", info)
	}
	anon.must(410, "GET", "/auth/password-reset/"+token+"x", nil, nil)
	anon.must(400, "POST", "/auth/password-reset/"+token, map[string]string{"password": "password123"}, nil)
	anon.must(204, "POST", "/auth/password-reset/"+token, map[string]string{"password": "carol-new-pass"}, nil)
	anon.must(410, "POST", "/auth/password-reset/"+token, map[string]string{"password": "carol-newer-pass"}, nil)
	carol.must(401, "GET", "/profile", nil, nil) // signed out everywhere
	carol.signIn("carol", "carol-new-pass")
	mailer.waitFor(t, "carol@example.com", "password was changed")

	// With two-factor sign-in, the link isn't enough on its own.
	var setup struct{ Secret string }
	carol.must(200, "POST", "/profile/mfa/setup", map[string]string{"password": "carol-new-pass"}, &setup)
	secret, _ := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ReplaceAll(setup.Secret, " ", ""))
	step := auth.TOTPStep(time.Now())
	carol.must(200, "POST", "/profile/mfa/enable", map[string]string{"code": auth.TOTPCode(secret, step)}, nil)
	mailer.waitFor(t, "carol@example.com", "Two-factor sign-in was turned on")
	anon.must(202, "POST", "/auth/password-reset", map[string]string{"login": "carol"}, nil)
	time.Sleep(100 * time.Millisecond)
	token = ""
	mailer.mu.Lock()
	for _, m := range mailer.sent {
		if strings.Contains(m.Subject, "Reset your") {
			token = tokenRe.FindStringSubmatch(m.Text)[1] // the newest
		}
	}
	mailer.mu.Unlock()
	anon.must(200, "GET", "/auth/password-reset/"+token, nil, &info)
	if !info.MfaRequired {
		t.Fatal("mfa_required is false")
	}
	anon.must(400, "POST", "/auth/password-reset/"+token, map[string]string{"password": "carol-third-pass"}, nil)
	anon.must(400, "POST", "/auth/password-reset/"+token, map[string]string{"password": "carol-third-pass", "code": "000000"}, nil)
	anon.must(204, "POST", "/auth/password-reset/"+token, map[string]string{"password": "carol-third-pass", "code": auth.TOTPCode(secret, step+1)}, nil)

	off := newTestEnv(t)

	// Reset links are capped per account, however it's named.
	resets := func() int {
		mailer.mu.Lock()
		defer mailer.mu.Unlock()
		n := 0
		for _, m := range mailer.sent {
			if m.To[0] == "carol@example.com" && strings.Contains(m.Subject, "Reset your") {
				n++
			}
		}
		return n
	}
	for _, login := range []string{"carol", "carol@example.com", "CAROL", "carol", "carol@example.com"} {
		anon.must(202, "POST", "/auth/password-reset", map[string]string{"login": login}, nil)
	}
	time.Sleep(300 * time.Millisecond)
	if n := resets(); n != 5 {
		t.Errorf("%d reset emails to one account in an hour, want 5", n)
	}

	// Without email, there's no reset by email, and invitations don't claim
	// an email failed.
	offAdmin := off.client(t)
	offAdmin.signIn("admin", "admin")
	offAdmin.must(201, "POST", "/organizations", map[string]string{"name": "Quiet"}, nil)
	var quiet struct {
		EmailSent  bool    `json:"email_sent"`
		EmailError *string `json:"email_error"`
	}
	offAdmin.must(201, "POST", "/organizations/quiet/invitations", map[string]any{"role": "developer", "email": "x@example.com"}, &quiet)
	if quiet.EmailSent || quiet.EmailError != nil {
		t.Errorf("with email off: %+v", quiet)
	}

	off.client(t).must(200, "GET", "/ui-config", nil, &ui)
	if ui.EmailEnabled {
		t.Fatal("email_enabled without a mail server")
	}
	off.client(t).must(409, "POST", "/auth/password-reset", map[string]string{"login": "admin"}, nil)
}
