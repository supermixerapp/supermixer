package auth

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"golang.org/x/crypto/argon2"
	"strings"
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
	// With two-factor sign-in: 8 characters, nothing guessable.
	for _, bad := range []string{"short", "password", "Password123!", "admin", "admin2026", "qwerty123", "12345678",
		"abcdefghij", "aaaaaaaaaa", "98765432", "supermixer1", "alice-smith", "htims-ecila",
		"liverpool1", "sunflower", "Sunflower2024!", // the NCSC list, and with digits and symbols added
		"ｐａｓｓｗｏｒｄ１", // full-width: the same password once normalized
		"日本語です",     // 5 characters, though 15 bytes
	} {
		if ValidateNewPassword(bad, "alice-smith", true) == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
	for _, ok := range []string{"long enough", "correct horse battery", "alice-password", "dev-password-1", "Tr1cky-Ferret-42", "日本語のパスワードです"} {
		if err := ValidateNewPassword(ok, "alice-smith", true); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	// The only way to sign in: 15 characters.
	if err := ValidateNewPassword("Tr1cky-Ferret-42", "alice-smith", false); err != nil {
		t.Errorf("16 characters: %v", err)
	}
	for _, bad := range []string{"Tr1cky-Ferret", "日本語のパスワードです"} {
		if err := ValidateNewPassword(bad, "alice-smith", false); err == nil || !strings.Contains(err.Error(), "15") {
			t.Errorf("%q without two-factor: %v", bad, err)
		}
	}
	if len(ncsc()) < 90000 {
		t.Errorf("the NCSC list has %d passwords", len(ncsc()))
	}
}

func TestPasswordNormalization(t *testing.T) {
	// Hashed normalized: the composed and decomposed forms are one password.
	h, _ := HashPassword("caf\u00e9-terrace-view")                       // é as one code point
	if err := VerifyPassword(h, "cafe\u0301-terrace-view"); err != nil { // e + combining accent
		t.Fatalf("decomposed form: %v", err)
	}
	// A hash made before normalization still matches the password as typed,
	// and says to remake it.
	salt := make([]byte, saltLen)
	raw := "ｆｕｌｌｗｉｄｔｈ-secret"
	key := argon2.IDKey([]byte(raw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	enc := base64.RawStdEncoding
	old := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		enc.EncodeToString(salt), enc.EncodeToString(key))
	if rehash, err := CheckPassword(old, raw); err != nil || !rehash {
		t.Fatalf("old hash: rehash %v, %v", rehash, err)
	}
	if rehash, err := CheckPassword(h, "caf\u00e9-terrace-view"); err != nil || rehash {
		t.Fatalf("new hash: rehash %v, %v", rehash, err)
	}
	if PasswordLength("cafe\u0301") != 4 {
		t.Errorf("length = %d", PasswordLength("cafe\u0301"))
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

// RFC 6238 Appendix B's SHA-1 vectors, truncated to 6 digits.
func TestTOTP(t *testing.T) {
	secret := []byte("12345678901234567890")
	for unix, want := range map[int64]string{59: "287082", 1111111109: "081804", 1234567890: "005924", 2000000000: "279037"} {
		if got := TOTPCode(secret, unix/30); got != want {
			t.Errorf("t=%d: %s, want %s", unix, got, want)
		}
	}
	now := time.Unix(1234567890, 0)
	if step, ok := VerifyTOTP(secret, "005 924", now); !ok || step != 1234567890/30 {
		t.Error("current code refused")
	}
	if _, ok := VerifyTOTP(secret, TOTPCode(secret, 1234567890/30-1), now); !ok {
		t.Error("previous step's code refused")
	}
	if _, ok := VerifyTOTP(secret, TOTPCode(secret, 1234567890/30-2), now); ok {
		t.Error("code from a minute ago accepted")
	}
	uri := TOTPURI(secret, "Supermixer", "alice@example.com")
	if uri != "otpauth://totp/Supermixer:alice@example.com?algorithm=SHA1&digits=6&issuer=Supermixer&period=30&secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" {
		t.Error(uri)
	}
	if svg, err := QRSVG(uri); err != nil || !strings.HasPrefix(svg, "<svg") {
		t.Fatal(err)
	}
	codes, _ := NewRecoveryCodes(10)
	if len(codes[0]) != 11 || codes[0][5] != '-' || !bytes.Equal(HashRecoveryCode(strings.ToUpper(codes[0])), HashRecoveryCode(codes[0])) {
		t.Error(codes[0])
	}
	if !LooksLikeTOTP("123 456") || LooksLikeTOTP(codes[0]) {
		t.Error("LooksLikeTOTP")
	}
}

func TestLimiterAttempt(t *testing.T) {
	l := NewLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if ok, _ := l.Attempt("k"); !ok {
			t.Fatalf("attempt %d refused", i+1)
		}
	}
	if ok, wait := l.Attempt("k"); ok || wait <= 0 {
		t.Fatal("fourth attempt allowed")
	}
	l.Reset("k")
	if ok, _ := l.Attempt("k"); !ok {
		t.Fatal("refused after reset")
	}
}
