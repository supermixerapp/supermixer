package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
)

// CSRF derives the anti-CSRF token for a session. The browser reads it from
// a non-HttpOnly cookie and echoes it in the X-CSRF-Token header; the server
// recomputes it from the session cookie, so no extra state is stored.
type CSRF struct{ key []byte }

// NewCSRF uses a key derived from the instance encryption key.
func NewCSRF(secret []byte) *CSRF {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("supermixer-csrf-v1"))
	return &CSRF{key: mac.Sum(nil)}
}

// Token returns the CSRF token for a session token.
func (c *CSRF) Token(sessionToken string) string {
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(sessionToken))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Valid reports whether header is the right CSRF token for sessionToken.
func (c *CSRF) Valid(sessionToken, header string) bool {
	return header != "" && hmac.Equal([]byte(c.Token(sessionToken)), []byte(header))
}
