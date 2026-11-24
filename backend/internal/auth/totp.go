package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"

	"rsc.io/qr"
)

// Two-factor sign-in with an authenticator app: TOTP (RFC 6238) with the
// parameters every app supports (HMAC-SHA1, 6 digits, 30-second steps), and
// single-use recovery codes for a lost device.

const (
	totpPeriod = 30
	totpDigits = 6
	// totpSkew accepts the step before and after, for clocks a little out.
	totpSkew = 1
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a random 160-bit secret (RFC 4226's recommended size).
func NewTOTPSecret() ([]byte, error) {
	s := make([]byte, 20)
	_, err := rand.Read(s)
	return s, err
}

// TOTPSecretText is how a secret is typed into an app: base32, in groups of four.
func TOTPSecretText(secret []byte) string {
	s := b32.EncodeToString(secret)
	var parts []string
	for len(s) > 4 {
		parts, s = append(parts, s[:4]), s[4:]
	}
	return strings.Join(append(parts, s), " ")
}

// TOTPURI is the otpauth:// URI apps read from the QR code.
func TOTPURI(secret []byte, issuer, account string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", b32.EncodeToString(secret))
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprint(totpDigits))
	q.Set("period", fmt.Sprint(totpPeriod))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// TOTPStep is the 30-second step t falls in.
func TOTPStep(t time.Time) int64 { return t.Unix() / totpPeriod }

// TOTPCode is the code for a step.
func TOTPCode(secret []byte, step int64) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(step))
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	n := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%0*d", totpDigits, n%1_000_000)
}

// VerifyTOTP checks a code against the steps around now, and returns the
// step it matched. Callers must refuse a step already used (replay).
func VerifyTOTP(secret []byte, code string, now time.Time) (int64, bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != totpDigits {
		return 0, false
	}
	step := TOTPStep(now)
	for d := -totpSkew; d <= totpSkew; d++ {
		if subtle.ConstantTimeCompare([]byte(TOTPCode(secret, step+int64(d))), []byte(code)) == 1 {
			return step + int64(d), true
		}
	}
	return 0, false
}

// LooksLikeTOTP tells a 6-digit code from a recovery code.
func LooksLikeTOTP(code string) bool {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != totpDigits {
		return false
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

const recoveryAlphabet = "abcdefghjkmnpqrstuvwxyz23456789" // no 0/o, 1/l/i

// NewRecoveryCodes returns n codes like "k7m2p-x9qrt" (about 49 bits each).
func NewRecoveryCodes(n int) ([]string, error) {
	codes := make([]string, n)
	size := big.NewInt(int64(len(recoveryAlphabet)))
	for i := range codes {
		var b strings.Builder
		for j := 0; j < 10; j++ {
			if j == 5 {
				b.WriteByte('-')
			}
			// rand.Int is uniform; a byte modulo 31 would favour some characters.
			k, err := rand.Int(rand.Reader, size)
			if err != nil {
				return nil, err
			}
			b.WriteByte(recoveryAlphabet[k.Int64()])
		}
		codes[i] = b.String()
	}
	return codes, nil
}

// HashRecoveryCode is how a recovery code is stored, ignoring case, spaces
// and the dash.
func HashRecoveryCode(code string) []byte {
	c := strings.ToLower(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(code)))
	sum := sha256.Sum256([]byte(c))
	return sum[:]
}

// QRSVG draws text as a QR code in SVG, with a quiet zone.
func QRSVG(text string) (string, error) {
	c, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	const quiet = 4
	size := c.Size + 2*quiet
	var path strings.Builder
	for y := 0; y < c.Size; y++ {
		for x := 0; x < c.Size; x++ {
			if c.Black(x, y) {
				fmt.Fprintf(&path, "M%d %dh1v1h-1z", x+quiet, y+quiet)
			}
		}
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`+
		`<rect width="100%%" height="100%%" fill="#fff"/><path fill="#000" d="%s"/></svg>`, size, size, path.String()), nil
}
