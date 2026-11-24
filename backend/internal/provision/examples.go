package provision

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"strings"
)

// Self-hosted Supabase ships example values for its secrets (docker/.env.example,
// and the CLI's local defaults). They're public, so a stack still using one
// can be taken over: anyone can mint a service_role token with the example
// JWT secret. Supermixer creates its stacks with fresh secrets; a stack it
// connects to may still have them.

// cliJWTSecret is the Supabase CLI's local JWT secret, also seen in
// self-hosted setups copied from it.
const cliJWTSecret = "super-secret-jwt-token-with-at-least-32-characters-long"

func exampleJWTSecrets() []string {
	return []string{ExampleEnv()["JWT_SECRET"], cliJWTSecret}
}

func exampleDBPasswords() []string {
	return []string{ExampleEnv()["POSTGRES_PASSWORD"], "postgres"}
}

// ExampleSecrets lists which of a stack's credentials are public example
// values: its JWT secret or database password, or legacy API keys signed
// with an example JWT secret (whichever are given).
func ExampleSecrets(jwtSecret, anonKey, serviceRoleKey, dbPassword string) []string {
	var out []string
	equal := func(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
	anyOf := func(v string, examples []string) bool {
		for _, e := range examples {
			if v != "" && equal(v, e) {
				return true
			}
		}
		return false
	}
	if anyOf(jwtSecret, exampleJWTSecrets()) {
		out = append(out, "JWT secret")
	}
	if signedWithExample(anonKey) {
		out = append(out, "anon key")
	}
	if signedWithExample(serviceRoleKey) {
		out = append(out, "service_role key")
	}
	if anyOf(dbPassword, exampleDBPasswords()) {
		out = append(out, "database password")
	}
	return out
}

// signedWithExample reports whether an HS256 token is signed with one of the
// example JWT secrets (so its own secret is one).
func signedWithExample(token string) bool {
	i := strings.LastIndexByte(token, '.')
	if i < 0 || strings.Count(token, ".") != 2 {
		return false
	}
	sig, err := base64.RawURLEncoding.DecodeString(token[i+1:])
	if err != nil {
		return false
	}
	for _, secret := range exampleJWTSecrets() {
		m := hmac.New(sha256.New, []byte(secret))
		m.Write([]byte(token[:i]))
		if hmac.Equal(sig, m.Sum(nil)) {
			return true
		}
	}
	return false
}
