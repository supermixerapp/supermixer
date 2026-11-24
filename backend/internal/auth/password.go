// Package auth handles passwords, session and invitation tokens, and
// sign-in rate limiting.
package auth

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	_ "embed"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
)

// Argon2id parameters (OWASP-recommended minimums: 19 MiB, 2 iterations).
const (
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
	saltLen      = 16
)

// Password lengths after NIST SP 800-63B-4, in characters (code points,
// after normalization): a password that is the only way to sign in needs
// 15; one used with a second factor (two-factor sign-in), 8.
const (
	MinPasswordLength             = 8
	MinSingleFactorPasswordLength = 15
	MaxPasswordLength             = 256
)

// NormalizePassword is applied before hashing and checking, so the same
// password typed on different keyboards or systems matches (NFKC, as NIST
// suggests).
func NormalizePassword(p string) string { return norm.NFKC.String(p) }

// PasswordLength counts characters as NIST does: code points, normalized.
func PasswordLength(p string) int { return utf8.RuneCountInString(NormalizePassword(p)) }

var ErrMismatch = errors.New("password does not match")

// HashPassword returns an encoded argon2id hash ($argon2id$v=19$m=...,t=...,p=...$salt$hash)
// of the normalized password.
func HashPassword(password string) (string, error) { return hash(NormalizePassword(password)) }

func hash(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// VerifyPassword checks password against an encoded hash in constant time.
func VerifyPassword(encoded, password string) error {
	_, err := CheckPassword(encoded, password)
	return err
}

// CheckPassword is VerifyPassword that also says whether the hash should be
// remade: hashes from before passwords were normalized match the password
// as typed, which is tried when the normalized one doesn't match.
func CheckPassword(encoded, password string) (rehash bool, err error) {
	n := NormalizePassword(password)
	err = verifyExact(encoded, n)
	if errors.Is(err, ErrMismatch) && n != password {
		if verifyExact(encoded, password) == nil {
			return true, nil
		}
	}
	return false, err
}

func verifyExact(encoded, password string) error {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return errors.New("unsupported password hash")
	}
	var version int
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return err
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return err
	}
	enc := base64.RawStdEncoding
	salt, err := enc.DecodeString(parts[4])
	if err != nil {
		return err
	}
	want, err := enc.DecodeString(parts[5])
	if err != nil {
		return err
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return ErrMismatch
	}
	return nil
}

// dummyHash is verified against when a username does not exist, so sign-in
// takes the same time either way.
var dummyHash, _ = HashPassword("supermixer-timing-equaliser")

// VerifyDummy burns the same time as a real verification.
func VerifyDummy(password string) { _ = VerifyPassword(dummyHash, password) }

// ValidateNewPassword enforces the password policy for passwords people
// choose, after NIST SP 800-63B-4: long enough (15 characters when it's the
// only way to sign in, 8 with two-factor sign-in), and not one an attacker
// would try first (the UK NCSC's 100,000 most used passwords, the username,
// the product's name, repeats and runs).
func ValidateNewPassword(password, username string, multiFactor bool) error {
	min := MinSingleFactorPasswordLength
	if multiFactor {
		min = MinPasswordLength
	}
	n := PasswordLength(password)
	if n < min {
		if multiFactor {
			return fmt.Errorf("password must be at least %d characters", min)
		}
		return fmt.Errorf("password must be at least %d characters (%d with two-factor sign-in on)", min, MinPasswordLength)
	}
	if n > MaxPasswordLength {
		return fmt.Errorf("password must be at most %d characters", MaxPasswordLength)
	}
	password = NormalizePassword(password)
	if guessable(password, username) {
		return errors.New("that password is too easy to guess: it's a common password, or made from the username or the product's name; choose another")
	}
	return nil
}

// commonPasswords are words and names that are common in passwords, or
// guessable for this product, besides the NCSC list (compared lowercased,
// and without trailing digits and symbols, so "Password123!" counts too).
var commonPasswords = map[string]bool{}

// The UK National Cyber Security Centre's 100,000 most used passwords, from
// SecLists (see gen_common_passwords.go and NOTICE): normalized, lowercased
// and sorted, read on first use.
//
//go:embed common-passwords.txt.gz
var ncscGz []byte

var ncsc = sync.OnceValue(func() []string {
	zr, err := gzip.NewReader(bytes.NewReader(ncscGz))
	if err != nil {
		panic("common-passwords.txt.gz: " + err.Error())
	}
	b, err := io.ReadAll(zr)
	if err != nil {
		panic("common-passwords.txt.gz: " + err.Error())
	}
	return strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
})

func isCommon(p string) bool {
	if commonPasswords[p] {
		return true
	}
	list := ncsc()
	_, found := slices.BinarySearch(list, p)
	return found
}

func init() {
	for _, p := range strings.Fields(`password passw0rd p@ssword p@ssw0rd qwerty qwertyuiop qwertyui asdfgh asdfghjkl
		zxcvbnm abcdef abcdefg abcdefgh letmein welcome welcome1 iloveyou admin administrator root toor changeme
		default secret master monkey dragon football baseball basketball soccer superman batman trustno1 sunshine
		princess shadow starwars whatever freedom computer internet login guest test tester testing temp temporary
		access hello charlie michael jennifer jordan hunter killer ninja mustang summer winter spring autumn
		lovely flower cheese pokemon minecraft google facebook microsoft apple samsung abc abcd abc123 qwe123
		qazwsx 1qaz2wsx zaq12wsx q1w2e3r4 a1b2c3d4 aa123456 changeit postgres supabase supermixer database`) {
		commonPasswords[p] = true
	}
}

func guessable(password, username string) bool {
	lower := strings.ToLower(password)
	core := strings.TrimRight(lower, "0123456789!@#$%^&*()-_=+.?~ ")
	if core == "" || isCommon(lower) || isCommon(core) {
		return true
	}
	if u := strings.ToLower(username); u != "" && (core == u || lower == u || reverse(lower) == u) {
		return true
	}
	// One character repeated, or a run such as 12345678, abcdefgh, 98765432.
	same, up, down := true, true, true
	r := []rune(lower)
	for i := 1; i < len(r); i++ {
		d := int(r[i]) - int(r[i-1])
		same, up, down = same && d == 0, up && d == 1, down && d == -1
	}
	return same || up || down
}

func reverse(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

// NewToken returns a random URL-safe token and its SHA-256 hash for storage.
func NewToken() (token string, hash []byte, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashToken(token), nil
}

// HashToken is how tokens are looked up: only hashes are stored.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// AccessTokenPrefix starts personal access tokens, as Supabase's do.
const AccessTokenPrefix = "sbp_"

// NewAccessToken returns a personal access token (sbp_ and 40 hex digits,
// 160 random bits), its hash for storage, and the start to show for it.
func NewAccessToken() (token string, hash []byte, shown string, err error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, "", err
	}
	token = AccessTokenPrefix + hex.EncodeToString(raw)
	return token, HashToken(token), token[:len(AccessTokenPrefix)+6], nil
}
