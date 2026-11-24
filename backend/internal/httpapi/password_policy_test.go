package httpapi

import (
	"context"
	"encoding/base32"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/argon2"

	"supermixer/internal/auth"
)

// NIST SP 800-63B-4: 15 characters for a password that's the only way in,
// 8 with two-factor sign-in.
func TestPasswordPolicy(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	conn := openTestDB(t, env.dbURL)
	setHash := func(user, hash string) {
		t.Helper()
		if _, err := conn.Exec(context.Background(), `update users set password_hash = $2, password_change_required = false where username = $1`, user, hash); err != nil {
			t.Fatal(err)
		}
	}
	var me struct {
		PasswordChangeRequired bool `json:"password_change_required"`
	}

	// New accounts have no second factor: 15 characters.
	admin.must(400, "POST", "/admin/users", map[string]any{"username": "erin", "password": "erin-pass-1234"}, nil)
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "erin", "password": "erin-password-123", "require_password_change": false}, nil)

	// A shorter password from before still signs in, then must be replaced.
	short, _ := auth.HashPassword("erin-short-1")
	setHash("erin", short)
	erin := env.client(t)
	erin.must(200, "POST", "/auth/sign-in", map[string]string{"username": "erin", "password": "erin-short-1"}, &me)
	if !me.PasswordChangeRequired {
		t.Fatal("a short password-only password wasn't flagged")
	}
	erin.must(403, "GET", "/organizations", nil, nil)
	erin.must(400, "POST", "/profile/password", map[string]string{"current_password": "erin-short-1", "new_password": "erin-new-12"}, nil)
	erin.must(204, "POST", "/profile/password", map[string]string{"current_password": "erin-short-1", "new_password": "erin-new-password-1"}, nil)

	// A hash from before passwords were normalized is remade at sign-in.
	var before, after string
	setHash("erin", oldStyleHash(t, "ｅｒｉｎ-fullwidth-secret"))
	_ = conn.QueryRow(context.Background(), `select password_hash from users where username = 'erin'`).Scan(&before)
	env.client(t).signIn("erin", "ｅｒｉｎ-fullwidth-secret")
	_ = conn.QueryRow(context.Background(), `select password_hash from users where username = 'erin'`).Scan(&after)
	if after == before || auth.VerifyPassword(after, "erin-fullwidth-secret") != nil {
		t.Fatal("the old hash wasn't remade normalized")
	}
	env.client(t).signIn("erin", "erin-fullwidth-secret") // the half-width form is the same password now

	// With two-factor sign-in on, 8 characters will do...
	erin = env.client(t)
	erin.signIn("erin", "erin-fullwidth-secret")
	var setup struct{ Secret string }
	erin.must(200, "POST", "/profile/mfa/setup", map[string]string{"password": "erin-fullwidth-secret"}, &setup)
	secret, _ := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ReplaceAll(setup.Secret, " ", ""))
	step := auth.TOTPStep(time.Now())
	erin.must(200, "POST", "/profile/mfa/enable", map[string]string{"code": auth.TOTPCode(secret, step)}, nil)
	erin.must(204, "POST", "/profile/password", map[string]string{"current_password": "erin-fullwidth-secret", "new_password": "erin-2fa-8"}, nil)
	// ...but turning it off then needs a longer one first.
	erin.must(409, "POST", "/profile/mfa/disable", map[string]string{"password": "erin-2fa-8", "code": auth.TOTPCode(secret, step+1)}, nil)

	// An admin turning someone's two-factor off asks them for a new password.
	var users []struct {
		ID       string
		Username string
	}
	admin.must(200, "GET", "/admin/users", nil, &users)
	for _, u := range users {
		if u.Username == "erin" {
			admin.must(204, "DELETE", "/admin/users/"+u.ID+"/mfa", nil, nil)
		}
	}
	env.client(t).must(200, "POST", "/auth/sign-in", map[string]string{"username": "erin", "password": "erin-2fa-8"}, &me)
	if !me.PasswordChangeRequired {
		t.Fatal("after an admin reset of two-factor sign-in, no new password was asked for")
	}
}

// oldStyleHash hashes a password as typed, without normalizing it, as
// Supermixer did before (same parameters and encoding as auth.HashPassword).
func oldStyleHash(t *testing.T, password string) string {
	t.Helper()
	salt := []byte("0123456789abcdef")
	key := argon2.IDKey([]byte(password), salt, 2, 19*1024, 1, 32)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, 19*1024, 2, 1, enc.EncodeToString(salt), enc.EncodeToString(key))
}
