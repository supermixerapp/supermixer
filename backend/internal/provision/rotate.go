package provision

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"time"
)

// Rotation is a stack secret that can be replaced (Stage 4.5).
type Rotation string

const (
	// RotateSecretKey replaces the sb_secret_ key; the old one stops working.
	RotateSecretKey Rotation = "secret_key"
	// RotatePublishableKey replaces the sb_publishable_ key.
	RotatePublishableKey Rotation = "publishable_key"
	// RotateSigningKey replaces the ES256 key Auth signs sessions with, and
	// the asymmetric tokens behind the sb_ keys. The previous public key
	// stays in the JWKS (verify only), so signed-in users stay signed in.
	RotateSigningKey Rotation = "signing_key"
	// RotateJWTSecret replaces the legacy HS256 secret and so the legacy
	// anon and service_role keys.
	RotateJWTSecret Rotation = "jwt_secret"
	// RotateFunctionsDBPassword replaces the Edge Functions' database login's password.
	RotateFunctionsDBPassword Rotation = "functions_db_password"
)

// Rotations are the stack secrets that can be replaced.
var Rotations = []Rotation{RotateSecretKey, RotatePublishableKey, RotateSigningKey, RotateJWTSecret, RotateFunctionsDBPassword}

// Rotate makes new values for a stack's .env, given its current one.
func Rotate(env map[string]string, which []Rotation, now time.Time) (map[string]string, error) {
	out := map[string]string{}
	var err error
	for _, r := range which {
		if !slices.Contains(Rotations, r) {
			return nil, fmt.Errorf("can't rotate %q", r)
		}
	}
	has := func(r Rotation) bool { return slices.Contains(which, r) }
	keys, jwks := env["JWT_KEYS"], env["JWT_JWKS"]
	if (has(RotateSigningKey) || has(RotateJWTSecret)) && (keys == "" || jwks == "") {
		return nil, fmt.Errorf("the stack has no JWT_KEYS or JWT_JWKS in its .env; it predates the newer API keys")
	}

	if has(RotateJWTSecret) {
		b, err := random(30)
		if err != nil {
			return nil, err
		}
		secret := base64.StdEncoding.EncodeToString(b)
		claims := func(role string) apiKeyClaims {
			return apiKeyClaims{Role: role, Iss: "supabase", Iat: now.Unix(), Exp: now.Add(keyLifetime).Unix()}
		}
		if out["ANON_KEY"], err = signHS256(secret, claims("anon")); err != nil {
			return nil, err
		}
		if out["SERVICE_ROLE_KEY"], err = signHS256(secret, claims("service_role")); err != nil {
			return nil, err
		}
		out["JWT_SECRET"] = secret
		// The JWKS carry the legacy secret too (as an oct key).
		k := base64.RawURLEncoding.EncodeToString([]byte(secret))
		if keys, err = mapJWKs(keys, false, func(j map[string]any) []map[string]any { return withOct(j, k) }); err != nil {
			return nil, fmt.Errorf("JWT_KEYS: %w", err)
		}
		if jwks, err = mapJWKs(jwks, true, func(j map[string]any) []map[string]any { return withOct(j, k) }); err != nil {
			return nil, fmt.Errorf("JWT_JWKS: %w", err)
		}
		out["JWT_KEYS"], out["JWT_JWKS"] = keys, jwks
	}

	if has(RotateSigningKey) {
		priv, signing, err := newSigningKey()
		if err != nil {
			return nil, err
		}
		verify := signing
		verify.KeyOps, verify.D = []string{"verify"}, ""
		// The old signing key, verify only; keys older than it go.
		demote := func(j map[string]any) []map[string]any {
			if j["kty"] != "EC" {
				return []map[string]any{j}
			}
			if !hasOp(j, "sign") {
				return nil
			}
			old := map[string]any{}
			for k, v := range j {
				if k != "d" {
					old[k] = v
				}
			}
			old["key_ops"] = []any{"verify"}
			return []map[string]any{old}
		}
		if keys, err = mapJWKs(keys, false, demote); err != nil {
			return nil, fmt.Errorf("JWT_KEYS: %w", err)
		}
		if jwks, err = mapJWKs(jwks, true, func(j map[string]any) []map[string]any {
			if j["kty"] == "EC" {
				// Every EC key here is verify-only; keep the one that signed.
				if kid, _ := j["kid"].(string); kid != currentKid(env["JWT_KEYS"]) {
					return nil
				}
			}
			return []map[string]any{j}
		}); err != nil {
			return nil, fmt.Errorf("JWT_JWKS: %w", err)
		}
		if keys, err = prependJWK(keys, false, signing); err != nil {
			return nil, err
		}
		if jwks, err = prependJWK(jwks, true, verify); err != nil {
			return nil, err
		}
		out["JWT_KEYS"], out["JWT_JWKS"] = keys, jwks
		if out["ANON_KEY_ASYMMETRIC"], err = signES256(priv, signing.Kid, "anon", now); err != nil {
			return nil, err
		}
		if out["SERVICE_ROLE_KEY_ASYMMETRIC"], err = signES256(priv, signing.Kid, "service_role", now); err != nil {
			return nil, err
		}
	}

	if has(RotateSecretKey) {
		if out["SUPABASE_SECRET_KEY"], err = opaqueKey("sb_secret_"); err != nil {
			return nil, err
		}
	}
	if has(RotatePublishableKey) {
		if out["SUPABASE_PUBLISHABLE_KEY"], err = opaqueKey("sb_publishable_"); err != nil {
			return nil, err
		}
	}
	if has(RotateFunctionsDBPassword) {
		b, err := random(16)
		if err != nil {
			return nil, err
		}
		out["FUNCTIONS_DB_PASSWORD"] = hex.EncodeToString(b)
	}
	return out, nil
}

func hasOp(j map[string]any, op string) bool {
	ops, _ := j["key_ops"].([]any)
	return slices.Contains(ops, any(op))
}

func withOct(j map[string]any, k string) []map[string]any {
	if j["kty"] == "oct" {
		j["k"] = k
	}
	return []map[string]any{j}
}

// currentKid is the kid of the EC key that signs, in a JWT_KEYS value.
func currentKid(keys string) string {
	var list []map[string]any
	_ = json.Unmarshal([]byte(keys), &list)
	for _, j := range list {
		if j["kty"] == "EC" && hasOp(j, "sign") {
			kid, _ := j["kid"].(string)
			return kid
		}
	}
	return ""
}

// mapJWKs rewrites each key of a JWT_KEYS value (a JSON array) or, with
// set, a JWT_JWKS one ({"keys": [...]}).
func mapJWKs(raw string, set bool, f func(map[string]any) []map[string]any) (string, error) {
	var list []map[string]any
	if set {
		var s struct {
			Keys []map[string]any `json:"keys"`
		}
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			return "", err
		}
		list = s.Keys
	} else if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return "", err
	}
	out := []map[string]any{}
	for _, j := range list {
		out = append(out, f(j)...)
	}
	var b []byte
	var err error
	if set {
		b, err = json.Marshal(map[string]any{"keys": out})
	} else {
		b, err = json.Marshal(out)
	}
	return string(b), err
}

func prependJWK(raw string, set bool, k ecJWK) (string, error) {
	b, err := json.Marshal(k)
	if err != nil {
		return "", err
	}
	var first map[string]any
	if err := json.Unmarshal(b, &first); err != nil {
		return "", err
	}
	done := false
	return mapJWKs(raw, set, func(j map[string]any) []map[string]any {
		if done {
			return []map[string]any{j}
		}
		done = true
		return []map[string]any{first, j}
	})
}

// newSigningKey makes an EC P-256 key for signing JWTs, as a JWK.
func newSigningKey() (*ecdsa.PrivateKey, ecJWK, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, ecJWK{}, fmt.Errorf("generating the signing key: %w", err)
	}
	kid, err := uuidV4()
	if err != nil {
		return nil, ecJWK{}, err
	}
	b64 := base64.RawURLEncoding
	pub := priv.PublicKey
	return priv, ecJWK{Kty: "EC", Kid: kid, Use: "sig", KeyOps: []string{"sign", "verify"}, Alg: "ES256", Ext: true,
		Crv: "P-256", X: b64.EncodeToString(pad32(pub.X.Bytes())), Y: b64.EncodeToString(pad32(pub.Y.Bytes())),
		D: b64.EncodeToString(pad32(priv.D.Bytes()))}, nil
}

// pad32 left-pads a P-256 coordinate or scalar to 32 bytes.
func pad32(b []byte) []byte {
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

// signES256 makes an API key token for role, signed with priv.
func signES256(priv *ecdsa.PrivateKey, kid, role string, now time.Time) (string, error) {
	b64 := base64.RawURLEncoding
	h, _ := json.Marshal(es256Header{Alg: "ES256", Typ: "JWT", Kid: kid})
	p, _ := json.Marshal(apiKeyClaims{Role: role, Iss: "supabase", Iat: now.Unix(), Exp: now.Add(keyLifetime).Unix()})
	data := b64.EncodeToString(h) + "." + b64.EncodeToString(p)
	digest := sha256.Sum256([]byte(data))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return "", err
	}
	return data + "." + b64.EncodeToString(append(pad32(r.Bytes()), pad32(s.Bytes())...)), nil // IEEE P1363: r || s
}
