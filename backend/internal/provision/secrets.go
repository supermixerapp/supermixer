package provision

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// Secrets are a new stack's generated credentials, made the way Supabase's
// utils/generate-keys.sh makes them (same sizes and encodings).
type Secrets struct {
	JWTSecret                  string
	AnonKey                    string
	ServiceRoleKey             string
	SecretKeyBase              string
	RealtimeDBEncKey           string
	VaultEncKey                string
	PGMetaCryptoKey            string
	LogflarePublicAccessToken  string
	LogflarePrivateAccessToken string
	S3ProtocolAccessKeyID      string
	S3ProtocolAccessKeySecret  string
	MinioRootPassword          string
	PostgresPassword           string
	DashboardPassword          string
}

// Env is the secrets as .env entries.
func (s Secrets) Env() map[string]string {
	return map[string]string{
		"JWT_SECRET":                    s.JWTSecret,
		"ANON_KEY":                      s.AnonKey,
		"SERVICE_ROLE_KEY":              s.ServiceRoleKey,
		"SECRET_KEY_BASE":               s.SecretKeyBase,
		"REALTIME_DB_ENC_KEY":           s.RealtimeDBEncKey,
		"VAULT_ENC_KEY":                 s.VaultEncKey,
		"PG_META_CRYPTO_KEY":            s.PGMetaCryptoKey,
		"LOGFLARE_PUBLIC_ACCESS_TOKEN":  s.LogflarePublicAccessToken,
		"LOGFLARE_PRIVATE_ACCESS_TOKEN": s.LogflarePrivateAccessToken,
		"S3_PROTOCOL_ACCESS_KEY_ID":     s.S3ProtocolAccessKeyID,
		"S3_PROTOCOL_ACCESS_KEY_SECRET": s.S3ProtocolAccessKeySecret,
		"MINIO_ROOT_PASSWORD":           s.MinioRootPassword,
		"POSTGRES_PASSWORD":             s.PostgresPassword,
		"DASHBOARD_PASSWORD":            s.DashboardPassword,
	}
}

// The anon and service_role keys last five years, as generate-keys.sh makes them.
const keyLifetime = 5 * 365 * 24 * time.Hour

// GenerateSecrets makes a fresh set from crypto/rand.
func GenerateSecrets(now time.Time) (Secrets, error) {
	var s Secrets
	var err error
	b64 := func(n int) string {
		if err != nil {
			return ""
		}
		var b []byte
		if b, err = random(n); err != nil {
			return ""
		}
		return base64.StdEncoding.EncodeToString(b)
	}
	hx := func(n int) string {
		if err != nil {
			return ""
		}
		var b []byte
		if b, err = random(n); err != nil {
			return ""
		}
		return hex.EncodeToString(b)
	}
	s.JWTSecret = b64(30)
	s.SecretKeyBase = b64(48)
	s.RealtimeDBEncKey = hx(8)
	s.VaultEncKey = hx(16)
	s.PGMetaCryptoKey = b64(24)
	s.LogflarePublicAccessToken = b64(24)
	s.LogflarePrivateAccessToken = b64(24)
	s.S3ProtocolAccessKeyID = hx(16)
	s.S3ProtocolAccessKeySecret = hx(32)
	s.MinioRootPassword = hx(16)
	s.PostgresPassword = hx(16)
	s.DashboardPassword = hx(16)
	if err != nil {
		return Secrets{}, err
	}
	iat := now.Unix()
	exp := now.Add(keyLifetime).Unix()
	if s.AnonKey, err = signHS256(s.JWTSecret, apiKeyClaims{Role: "anon", Iss: "supabase", Iat: iat, Exp: exp}); err != nil {
		return Secrets{}, err
	}
	if s.ServiceRoleKey, err = signHS256(s.JWTSecret, apiKeyClaims{Role: "service_role", Iss: "supabase", Iat: iat, Exp: exp}); err != nil {
		return Secrets{}, err
	}
	return s, nil
}

func random(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("generating secrets: %w", err)
	}
	return b, nil
}

// Field order matches generate-keys.sh's payload.
type apiKeyClaims struct {
	Role string `json:"role"`
	Iss  string `json:"iss"`
	Iat  int64  `json:"iat"`
	Exp  int64  `json:"exp"`
}

// signHS256 makes a compact JWT. The secret is used as text, as Supabase's
// services read JWT_SECRET.
func signHS256(secret string, claims any) (string, error) {
	enc := base64.RawURLEncoding
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signed := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signed))
	return signed + "." + enc.EncodeToString(mac.Sum(nil)), nil
}
