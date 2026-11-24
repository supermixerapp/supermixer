package httpapi

import (
	"encoding/base32"
	"strings"
	"testing"
	"time"

	"supermixer/internal/auth"
)

func TestMFA(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", "admin")
	code := func(secret []byte, ahead int64) string { return auth.TOTPCode(secret, auth.TOTPStep(time.Now())+ahead) }

	// Setting up: the password, then a code from the app.
	var status struct {
		Enabled           bool `json:"enabled"`
		RecoveryCodesLeft int  `json:"recovery_codes_left"`
	}
	admin.must(200, "GET", "/profile/mfa", nil, &status)
	if status.Enabled {
		t.Fatal("on before setting up")
	}
	admin.must(400, "POST", "/profile/mfa/setup", map[string]string{"password": "wrong"}, nil)
	var setup struct {
		Secret string `json:"secret"`
		URI    string `json:"uri"`
		QRSVG  string `json:"qr_svg"`
	}
	admin.must(200, "POST", "/profile/mfa/setup", map[string]string{"password": "admin"}, &setup)
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ReplaceAll(setup.Secret, " ", ""))
	if err != nil || !strings.HasPrefix(setup.URI, "otpauth://totp/Supermixer:admin@") || !strings.HasPrefix(setup.QRSVG, "<svg") {
		t.Fatalf("setup = %+v (%v)", setup, err)
	}
	admin.must(400, "POST", "/profile/mfa/enable", map[string]string{"code": "000000"}, nil)
	var rc struct{ Codes []string }
	other := env.client(t)
	other.signIn("admin", "admin") // with the password alone
	admin.must(200, "POST", "/profile/mfa/enable", map[string]string{"code": code(secret, 0)}, &rc)
	other.must(401, "GET", "/profile", nil, nil) // signed out by turning it on
	admin.must(200, "GET", "/profile", nil, nil)
	if len(rc.Codes) != 10 {
		t.Fatalf("recovery codes = %v", rc.Codes)
	}
	admin.must(409, "POST", "/profile/mfa/setup", map[string]string{"password": "admin"}, nil)
	admin.must(200, "GET", "/profile/mfa", nil, &status)
	if !status.Enabled || status.RecoveryCodesLeft != 10 {
		t.Fatalf("status = %+v", status)
	}

	// Signing in: the password gives a challenge and no session.
	signIn := func() (*client, string) {
		c := env.client(t)
		var ch struct {
			MfaRequired bool   `json:"mfa_required"`
			Challenge   string `json:"challenge"`
		}
		c.must(202, "POST", "/auth/sign-in", map[string]string{"username": "admin", "password": "admin"}, &ch)
		if !ch.MfaRequired || ch.Challenge == "" {
			t.Fatalf("challenge = %+v", ch)
		}
		c.must(401, "GET", "/profile", nil, nil)
		return c, ch.Challenge
	}
	c, ch := signIn()
	c.must(401, "POST", "/auth/mfa", map[string]string{"challenge": ch, "code": code(secret, 0)}, nil) // used to enable
	c.must(401, "POST", "/auth/mfa", map[string]string{"challenge": ch + "x", "code": code(secret, 1)}, nil)
	c.must(200, "POST", "/auth/mfa", map[string]string{"challenge": ch, "code": code(secret, 1)}, nil)
	c.must(200, "GET", "/profile", nil, nil)
	// A challenge makes one session, and a valid code isn't spent on it.
	env.client(t).must(401, "POST", "/auth/mfa", map[string]string{"challenge": ch, "code": rc.Codes[2]}, nil)
	c2, ch2 := signIn()
	c2.must(401, "POST", "/auth/mfa", map[string]string{"challenge": ch2, "code": code(secret, 1)}, nil) // used already
	c2.must(200, "POST", "/auth/mfa", map[string]string{"challenge": ch2, "code": strings.ToUpper(rc.Codes[0])}, nil)
	c3, ch3 := signIn()
	c3.must(401, "POST", "/auth/mfa", map[string]string{"challenge": ch3, "code": rc.Codes[0]}, nil) // single use
	admin.must(200, "GET", "/profile/mfa", nil, &status)
	if status.RecoveryCodesLeft != 9 {
		t.Errorf("recovery codes left = %d", status.RecoveryCodesLeft)
	}

	// An organization that requires it: members without it see its name
	// and can leave, nothing else.
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Vault"}, nil)
	bob := joinAs(t, env, admin, "vault", "bob", "developer")
	bob.must(200, "GET", "/organizations/vault/members", nil, nil)
	admin.must(200, "PATCH", "/organizations/vault", map[string]any{"mfa_required": true}, nil)
	var org struct {
		MfaRequired bool `json:"mfa_required"`
	}
	bob.must(200, "GET", "/organizations/vault", nil, &org)
	var denied struct{ Code string }
	bob.must(403, "GET", "/organizations/vault/members", nil, &denied)
	if !org.MfaRequired || denied.Code != "mfa_required" {
		t.Fatalf("org = %+v, denied = %+v", org, denied)
	}
	var members []struct {
		Username   string
		MfaEnabled bool `json:"mfa_enabled"`
	}
	admin.must(200, "GET", "/organizations/vault/members", nil, &members)
	for _, m := range members {
		if m.MfaEnabled != (m.Username == "admin") {
			t.Errorf("member %+v", m)
		}
	}
	// Without it yourself, you can't require it.
	bob.must(201, "POST", "/organizations", map[string]string{"name": "Bobs"}, nil)
	bob.must(400, "PATCH", "/organizations/bobs", map[string]any{"mfa_required": true}, nil)
	var me struct{ ID string }
	bob.must(200, "GET", "/profile", nil, &me)
	bob.must(204, "DELETE", "/organizations/vault/members/"+me.ID, nil, nil)

	// Turning it off takes the password and a code; an admin can reset it.
	admin.must(400, "POST", "/profile/mfa/disable", map[string]string{"password": "admin", "code": "nope-nope"}, nil)
	admin.must(204, "POST", "/profile/mfa/disable", map[string]string{"password": "admin", "code": rc.Codes[1]}, nil)
	admin.must(200, "GET", "/profile/mfa", nil, &status)
	if status.Enabled || status.RecoveryCodesLeft != 0 {
		t.Fatalf("after disabling: %+v", status)
	}
	admin.must(409, "DELETE", "/admin/users/"+me.ID+"/mfa", nil, nil)
	bob.must(200, "POST", "/profile/mfa/setup", map[string]string{"password": "bob-password"}, &setup)
	secret, _ = base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ReplaceAll(setup.Secret, " ", ""))
	bob.must(200, "POST", "/profile/mfa/enable", map[string]string{"code": code(secret, 0)}, &rc)
	bob.must(200, "POST", "/profile/mfa/recovery-codes", map[string]string{"code": code(secret, 1)}, &rc)
	admin.must(204, "DELETE", "/admin/users/"+me.ID+"/mfa", nil, nil)
	bob.must(401, "GET", "/profile", nil, nil) // signed out everywhere

	var audit struct {
		Entries []struct{ Action string } `json:"entries"`
	}
	admin.must(200, "GET", "/admin/audit-logs?action=user.&limit=200", nil, &audit)
	seen := map[string]bool{}
	for _, e := range audit.Entries {
		seen[e.Action] = true
	}
	for _, want := range []string{"user.mfa_enabled", "user.mfa_failed", "user.mfa_disabled", "user.recovery_codes_replaced", "user.mfa_reset"} {
		if !seen[want] {
			t.Errorf("no %s in the audit log", want)
		}
	}
}
