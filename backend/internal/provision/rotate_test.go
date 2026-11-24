package provision

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"maps"
	"math/big"
	"regexp"
	"strings"
	"testing"
	"time"
)

func stackKeysEnv(t *testing.T) map[string]string {
	t.Helper()
	now := time.Now()
	s, err := GenerateSecrets(now)
	if err != nil {
		t.Fatal(err)
	}
	k, err := GenerateAPIKeys(s.JWTSecret, now)
	if err != nil {
		t.Fatal(err)
	}
	env := s.Env()
	maps.Copy(env, k.Env())
	return env
}

func jwkList(t *testing.T, raw string, set bool) []map[string]any {
	t.Helper()
	var list []map[string]any
	if set {
		var s struct{ Keys []map[string]any }
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			t.Fatal(err)
		}
		return s.Keys
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		t.Fatal(err)
	}
	return list
}

// verifiesES256 checks token against the EC key in jwks with its kid.
func verifiesES256(t *testing.T, token string, jwks []map[string]any) bool {
	t.Helper()
	parts := strings.Split(token, ".")
	head, _ := base64.RawURLEncoding.DecodeString(parts[0])
	var h struct{ Kid string }
	_ = json.Unmarshal(head, &h)
	for _, j := range jwks {
		if j["kid"] != h.Kid {
			continue
		}
		x, _ := base64.RawURLEncoding.DecodeString(j["x"].(string))
		y, _ := base64.RawURLEncoding.DecodeString(j["y"].(string))
		pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		return ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
	}
	return false
}

func verifiesHS256(token, secret string) bool {
	parts := strings.Split(token, ".")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) == parts[2]
}

func TestRotate(t *testing.T) {
	env := stackKeysEnv(t)
	apply := func(which ...Rotation) map[string]string {
		t.Helper()
		out, err := Rotate(env, which, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		next := maps.Clone(env)
		maps.Copy(next, out)
		return next
	}

	// Opaque keys and the functions' password.
	n := apply(RotateSecretKey, RotatePublishableKey, RotateFunctionsDBPassword)
	if n["SUPABASE_SECRET_KEY"] == env["SUPABASE_SECRET_KEY"] || !OpaqueKeyValid(n["SUPABASE_SECRET_KEY"]) ||
		!strings.HasPrefix(n["SUPABASE_SECRET_KEY"], "sb_secret_") {
		t.Errorf("secret key = %q", n["SUPABASE_SECRET_KEY"])
	}
	if n["SUPABASE_PUBLISHABLE_KEY"] == env["SUPABASE_PUBLISHABLE_KEY"] || !OpaqueKeyValid(n["SUPABASE_PUBLISHABLE_KEY"]) {
		t.Errorf("publishable key = %q", n["SUPABASE_PUBLISHABLE_KEY"])
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(n["FUNCTIONS_DB_PASSWORD"]) || n["FUNCTIONS_DB_PASSWORD"] == env["FUNCTIONS_DB_PASSWORD"] {
		t.Errorf("functions password = %q", n["FUNCTIONS_DB_PASSWORD"])
	}
	if n["JWT_KEYS"] != env["JWT_KEYS"] || n["ANON_KEY"] != env["ANON_KEY"] {
		t.Error("rotating the opaque keys changed the JWT keys")
	}

	// The legacy secret: new HS256 keys, and the oct key in both JWKS.
	n = apply(RotateJWTSecret)
	if n["JWT_SECRET"] == env["JWT_SECRET"] || !verifiesHS256(n["ANON_KEY"], n["JWT_SECRET"]) ||
		!verifiesHS256(n["SERVICE_ROLE_KEY"], n["JWT_SECRET"]) || verifiesHS256(n["ANON_KEY"], env["JWT_SECRET"]) {
		t.Error("the legacy keys aren't signed with the new secret")
	}
	k := base64.RawURLEncoding.EncodeToString([]byte(n["JWT_SECRET"]))
	for _, l := range [][]map[string]any{jwkList(t, n["JWT_KEYS"], false), jwkList(t, n["JWT_JWKS"], true)} {
		for _, j := range l {
			if j["kty"] == "oct" && j["k"] != k {
				t.Errorf("oct key not updated: %v", j)
			}
		}
	}
	if n["ANON_KEY_ASYMMETRIC"] != env["ANON_KEY_ASYMMETRIC"] {
		t.Error("rotating the legacy secret changed the asymmetric keys")
	}

	// The signing key: the old one stays, verify only, until the next rotation.
	oldKid := currentKid(env["JWT_KEYS"])
	n = apply(RotateSigningKey)
	keys, jwks := jwkList(t, n["JWT_KEYS"], false), jwkList(t, n["JWT_JWKS"], true)
	if len(keys) != 3 || keys[0]["kty"] != "EC" || keys[0]["d"] == nil || !hasOp(keys[0], "sign") {
		t.Fatalf("JWT_KEYS = %s", n["JWT_KEYS"])
	}
	newKid := keys[0]["kid"]
	for _, j := range append(keys[1:], jwks...) {
		if j["kty"] == "EC" && (j["d"] != nil || hasOp(j, "sign")) {
			t.Errorf("a private or signing key outside its place: %v", j)
		}
	}
	if len(jwks) != 3 || jwks[0]["kid"] != newKid || jwks[1]["kid"] != oldKid || keys[1]["kid"] != oldKid {
		t.Errorf("JWKS after rotating: %v / %v", keys, jwks)
	}
	if !verifiesES256(t, n["ANON_KEY_ASYMMETRIC"], jwks) || !verifiesES256(t, n["SERVICE_ROLE_KEY_ASYMMETRIC"], jwks) ||
		!verifiesES256(t, env["ANON_KEY_ASYMMETRIC"], jwks) {
		t.Error("tokens from the new and previous key should both verify")
	}
	if currentKid(n["JWT_KEYS"]) != newKid {
		t.Error("currentKid doesn't follow the rotation")
	}
	// Again: the oldest key goes.
	env = n
	n = apply(RotateSigningKey)
	keys, jwks = jwkList(t, n["JWT_KEYS"], false), jwkList(t, n["JWT_JWKS"], true)
	if len(keys) != 3 || len(jwks) != 3 || jwks[1]["kid"] != newKid {
		t.Errorf("after a second rotation: %v / %v", keys, jwks)
	}
	for _, j := range append(keys, jwks...) {
		if j["kid"] == oldKid {
			t.Error("the key from two rotations ago is still there")
		}
	}

	// Both at once.
	n = apply(RotateSigningKey, RotateJWTSecret)
	if !verifiesHS256(n["ANON_KEY"], n["JWT_SECRET"]) || !verifiesES256(t, n["ANON_KEY_ASYMMETRIC"], jwkList(t, n["JWT_JWKS"], true)) {
		t.Error("rotating both didn't leave consistent keys")
	}

	if _, err := Rotate(env, []Rotation{"postgres_password"}, time.Now()); err == nil {
		t.Error("an unknown rotation was accepted")
	}
	delete(env, "JWT_KEYS")
	if _, err := Rotate(env, []Rotation{RotateSigningKey}, time.Now()); err == nil {
		t.Error("rotating the signing key without JWT_KEYS was accepted")
	}
}
