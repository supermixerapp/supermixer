package provision

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// APIKeys are Supabase's newer API keys, made the way its
// utils/add-new-auth-keys.sh makes them: an EC P-256 signing key (published
// as a JWKS next to the legacy HS256 secret, so old keys keep working),
// ES256 anon and service_role tokens, and opaque sb_publishable_/sb_secret_
// keys that the API gateway translates into those tokens.
type APIKeys struct {
	Publishable string
	Secret      string
	// AnonAsymmetric and ServiceRoleAsymmetric are what the gateway sends on
	// for the opaque keys.
	AnonAsymmetric        string
	ServiceRoleAsymmetric string
	// JWTKeys is the private JWKS (Auth signs with it); JWTJWKS the public
	// one (the other services verify with it).
	JWTKeys string
	JWTJWKS string
}

// Env is the keys as .env entries.
func (k APIKeys) Env() map[string]string {
	return map[string]string{
		"SUPABASE_PUBLISHABLE_KEY":    k.Publishable,
		"SUPABASE_SECRET_KEY":         k.Secret,
		"ANON_KEY_ASYMMETRIC":         k.AnonAsymmetric,
		"SERVICE_ROLE_KEY_ASYMMETRIC": k.ServiceRoleAsymmetric,
		"JWT_KEYS":                    k.JWTKeys,
		"JWT_JWKS":                    k.JWTJWKS,
	}
}

// Field order follows the script's JSON.
type ecJWK struct {
	Kty    string   `json:"kty"`
	Kid    string   `json:"kid"`
	Use    string   `json:"use"`
	KeyOps []string `json:"key_ops"`
	Alg    string   `json:"alg"`
	Ext    bool     `json:"ext"`
	Crv    string   `json:"crv"`
	X      string   `json:"x"`
	Y      string   `json:"y"`
	D      string   `json:"d,omitempty"`
}

type octJWK struct {
	Kty string `json:"kty"`
	K   string `json:"k"`
	Alg string `json:"alg"`
}

type es256Header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid"`
}

// The opaque keys' checksum names this, as in the script.
const opaqueKeyProject = "supabase-self-hosted"

// GenerateAPIKeys makes the newer keys for a stack whose legacy JWT secret is jwtSecret.
func GenerateAPIKeys(jwtSecret string, now time.Time) (APIKeys, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return APIKeys{}, fmt.Errorf("generating the signing key: %w", err)
	}
	kid, err := uuidV4()
	if err != nil {
		return APIKeys{}, err
	}
	b64 := base64.RawURLEncoding
	pad := func(b []byte) []byte { // coordinates are 32 bytes, left-padded
		out := make([]byte, 32)
		copy(out[32-len(b):], b)
		return out
	}
	pub := priv.PublicKey
	x, y := b64.EncodeToString(pad(pub.X.Bytes())), b64.EncodeToString(pad(pub.Y.Bytes()))
	oct := octJWK{Kty: "oct", K: b64.EncodeToString([]byte(jwtSecret)), Alg: "HS256"}
	signing := ecJWK{Kty: "EC", Kid: kid, Use: "sig", KeyOps: []string{"sign", "verify"}, Alg: "ES256", Ext: true,
		Crv: "P-256", X: x, Y: y, D: b64.EncodeToString(pad(priv.D.Bytes()))}
	verify := signing
	verify.KeyOps, verify.D = []string{"verify"}, ""

	keys, err := json.Marshal([]any{signing, oct})
	if err != nil {
		return APIKeys{}, err
	}
	jwks, err := json.Marshal(map[string][]any{"keys": {verify, oct}})
	if err != nil {
		return APIKeys{}, err
	}

	iat, exp := now.Unix(), now.Add(keyLifetime).Unix()
	sign := func(role string) (string, error) {
		h, _ := json.Marshal(es256Header{Alg: "ES256", Typ: "JWT", Kid: kid})
		p, _ := json.Marshal(apiKeyClaims{Role: role, Iss: "supabase", Iat: iat, Exp: exp})
		data := b64.EncodeToString(h) + "." + b64.EncodeToString(p)
		digest := sha256.Sum256([]byte(data))
		r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
		if err != nil {
			return "", err
		}
		sig := append(pad(r.Bytes()), pad(s.Bytes())...) // IEEE P1363: r || s
		return data + "." + b64.EncodeToString(sig), nil
	}
	out := APIKeys{JWTKeys: string(keys), JWTJWKS: string(jwks)}
	if out.AnonAsymmetric, err = sign("anon"); err != nil {
		return APIKeys{}, err
	}
	if out.ServiceRoleAsymmetric, err = sign("service_role"); err != nil {
		return APIKeys{}, err
	}
	if out.Publishable, err = opaqueKey("sb_publishable_"); err != nil {
		return APIKeys{}, err
	}
	if out.Secret, err = opaqueKey("sb_secret_"); err != nil {
		return APIKeys{}, err
	}
	return out, nil
}

// opaqueKey is prefix + 22 random base64url characters + "_" + an 8-character checksum.
func opaqueKey(prefix string) (string, error) {
	b, err := random(17)
	if err != nil {
		return "", err
	}
	intermediate := prefix + base64.RawURLEncoding.EncodeToString(b)[:22]
	sum := sha256.Sum256([]byte(opaqueKeyProject + "|" + intermediate))
	return intermediate + "_" + base64.RawURLEncoding.EncodeToString(sum[:])[:8], nil
}

// OpaqueKeyValid checks an sb_ key's checksum.
func OpaqueKeyValid(key string) bool {
	i := strings.LastIndex(key, "_")
	if i < 0 || len(key)-i-1 != 8 {
		return false
	}
	sum := sha256.Sum256([]byte(opaqueKeyProject + "|" + key[:i]))
	return base64.RawURLEncoding.EncodeToString(sum[:])[:8] == key[i+1:]
}

func uuidV4() (string, error) {
	b, err := random(16)
	if err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

// The services' settings for the signing keys ship commented out; the
// newer keys need them on (as add-new-auth-keys.sh does).
var jwksSettings = regexp.MustCompile(`(?m)^(\s*)#((?:GOTRUE_JWT_KEYS|API_JWT_JWKS|JWT_JWKS|SUPABASE_JWKS):)`)

func enableJWKS(compose string) (string, error) {
	out := jwksSettings.ReplaceAllString(compose, "$1$2")
	for _, name := range []string{"GOTRUE_JWT_KEYS", "API_JWT_JWKS", "JWT_JWKS", "SUPABASE_JWKS"} {
		if !regexp.MustCompile(`(?m)^\s*` + name + `:`).MatchString(out) {
			return "", fmt.Errorf("docker-compose.yml has no %s setting to turn on; the newer API keys wouldn't work", name)
		}
	}
	return out, nil
}
