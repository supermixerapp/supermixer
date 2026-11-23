package auth

import (
	"testing"
	"time"
)

func TestPasswordRoundTrip(t *testing.T) {
	h, err := HashPassword("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyPassword(h, "correct horse"); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if err := VerifyPassword(h, "wrong"); err != ErrMismatch {
		t.Fatalf("want mismatch, got %v", err)
	}
	h2, _ := HashPassword("correct horse")
	if h == h2 {
		t.Fatal("hashes must be salted")
	}
}

func TestValidateNewPassword(t *testing.T) {
	if ValidateNewPassword("short") == nil {
		t.Error("short password accepted")
	}
	if ValidateNewPassword("long enough") != nil {
		t.Error("valid password rejected")
	}
}

func TestTokens(t *testing.T) {
	tok, hash, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if string(HashToken(tok)) != string(hash) || len(tok) < 40 {
		t.Fatalf("token %q", tok)
	}
}

func TestCSRF(t *testing.T) {
	c := NewCSRF([]byte("secret"))
	tok := c.Token("session-a")
	if !c.Valid("session-a", tok) {
		t.Fatal("valid token rejected")
	}
	if c.Valid("session-b", tok) || c.Valid("session-a", "") {
		t.Fatal("token accepted for wrong session or empty")
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(3, time.Minute)
	l.now = func() time.Time { return now }
	for range 3 {
		l.Fail("ip")
	}
	if blocked, _ := l.Blocked("ip"); !blocked {
		t.Fatal("expected blocked after 3 failures")
	}
	now = now.Add(61 * time.Second)
	if blocked, _ := l.Blocked("ip"); blocked {
		t.Fatal("expected window to reset")
	}
	l.Fail("user")
	l.Reset("user")
	if blocked, _ := l.Blocked("user"); blocked {
		t.Fatal("reset did not clear")
	}
}
