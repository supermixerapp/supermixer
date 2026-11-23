package provision

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestTemplateIsPinned(t *testing.T) {
	if v := TemplateVersion(); len(v) != 40 {
		t.Fatalf("TemplateVersion() = %q, want a commit sha", v)
	}
}

// The Go scoping must match deploy/dev-stacks' Python scripts byte for byte.
func TestScopingMatchesTheDevStackScripts(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 isn't installed")
	}
	scripts, _ := filepath.Abs("../../../deploy/dev-stacks")
	dir := t.TempDir()
	for _, f := range []string{"docker-compose.yml", "docker-compose.logs.yml", "volumes/logs/vector.yml"} {
		b, err := fs.ReadFile(templateFS, "template/"+f)
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(dir, f)
		_ = os.MkdirAll(filepath.Dir(dst), 0o755)
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run := func(args ...string) {
		cmd := exec.Command("python3", append([]string{"-B"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	run(filepath.Join(scripts, "scope-containers.py"), "docker-compose.yml", "docker-compose.logs.yml")
	run(filepath.Join(scripts, "scope-vector.py"), "--project", "stack-x", "volumes/logs/vector.yml", "docker-compose.yml", "docker-compose.logs.yml")

	compose, _ := fs.ReadFile(templateFS, "template/docker-compose.yml")
	logs, _ := fs.ReadFile(templateFS, "template/docker-compose.logs.yml")
	vector, _ := fs.ReadFile(templateFS, "template/volumes/logs/vector.yml")
	goCompose, err := scopeContainers(string(compose))
	if err != nil {
		t.Fatal(err)
	}
	goLogs, err := scopeContainers(string(logs))
	if err != nil {
		t.Fatal(err)
	}
	goVector, err := scopeVector(string(vector), "stack-x", serviceAliases(goCompose, goLogs))
	if err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string]string{"docker-compose.yml": goCompose, "docker-compose.logs.yml": goLogs, "volumes/logs/vector.yml": goVector} {
		want, _ := os.ReadFile(filepath.Join(dir, name))
		if got != string(want) {
			t.Errorf("%s differs from the Python scripts' output", name)
		}
	}
	if strings.Contains(goCompose, "container_name:") {
		t.Error("container_name left in docker-compose.yml")
	}
}

func TestScopeVectorRefusesWhatItCannotScope(t *testing.T) {
	if _, err := scopeVector("sources:\n  x:\n    type: file\n", "p", nil); err == nil {
		t.Error("accepted a vector.yml with no docker_logs source")
	}
	if _, err := scopeVector("x", "Bad Name", nil); err == nil {
		t.Error("accepted an invalid project name")
	}
}

func TestGenerateSecrets(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	s, err := GenerateSecrets(now)
	if err != nil {
		t.Fatal(err)
	}
	// Sizes match generate-keys.sh.
	if b, _ := base64.StdEncoding.DecodeString(s.JWTSecret); len(b) != 30 {
		t.Errorf("JWT secret is %d bytes", len(b))
	}
	if b, _ := hex.DecodeString(s.VaultEncKey); len(b) != 16 {
		t.Errorf("Vault key is %d bytes", len(b))
	}
	if b, _ := hex.DecodeString(s.PostgresPassword); len(b) != 16 {
		t.Errorf("Postgres password is %d bytes", len(b))
	}
	for name, v := range s.Env() {
		if v == "" || strings.ContainsAny(v, "\n\"' ") {
			t.Errorf("%s = %q is empty or needs quoting", name, v)
		}
	}
	other, _ := GenerateSecrets(now)
	if other.JWTSecret == s.JWTSecret || other.PostgresPassword == s.PostgresPassword {
		t.Error("two stacks got the same secrets")
	}

	for role, token := range map[string]string{"anon": s.AnonKey, "service_role": s.ServiceRoleKey} {
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			t.Fatalf("%s key isn't a JWT", role)
		}
		mac := hmac.New(sha256.New, []byte(s.JWTSecret))
		mac.Write([]byte(parts[0] + "." + parts[1]))
		if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != parts[2] {
			t.Errorf("%s key's signature doesn't verify with the JWT secret", role)
		}
		payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var c apiKeyClaims
		if err := json.Unmarshal(payload, &c); err != nil {
			t.Fatal(err)
		}
		if c.Role != role || c.Iss != "supabase" || c.Iat != now.Unix() || c.Exp != now.Add(keyLifetime).Unix() {
			t.Errorf("%s claims = %+v", role, c)
		}
	}
}

func TestRenderEnv(t *testing.T) {
	out := renderEnv("# comment\nA=1\nB=2\nA=3\n", map[string]string{"A": "x", "C": "y"})
	if out != "# comment\nA=x\nB=2\nA=3\n\n# Set by Supermixer\nC=y\n" {
		t.Fatalf("renderEnv = %q", out)
	}
}

func TestWriteStack(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "stack")
	l := Layout{Dir: dir, Project: "supermixer-abc"}
	if err := WriteStack(l, map[string]string{"POSTGRES_PASSWORD": "pw", "API_GW_HTTP_PORT": "8200"}); err != nil {
		t.Fatal(err)
	}
	env, err := ReadEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	if env["POSTGRES_PASSWORD"] != "pw" || env["API_GW_HTTP_PORT"] != "8200" {
		t.Errorf("env = %v", env)
	}
	if fi, _ := os.Stat(filepath.Join(dir, ".env")); fi.Mode().Perm() != 0o600 {
		t.Errorf(".env mode = %v", fi.Mode().Perm())
	}
	if fi, _ := os.Stat(filepath.Join(dir, "volumes/api/envoy/docker-entrypoint.sh")); fi.Mode().Perm()&0o100 == 0 {
		t.Error("entrypoint script isn't executable")
	}
	vector, _ := os.ReadFile(filepath.Join(dir, "volumes/logs/vector.yml"))
	if !strings.Contains(string(vector), "- com.docker.compose.project=supermixer-abc") {
		t.Error("vector.yml isn't limited to the stack")
	}
	for _, f := range composeFiles {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}
	if err := WriteStack(l, nil); err == nil {
		t.Error("overwrote an existing stack folder")
	}
}

func TestAllocatePorts(t *testing.T) {
	taken := map[int]bool{8200: true, 54400: true}
	busy := map[int]bool{8201: true}
	p, err := AllocatePorts(PortRange{8200, 8203}, PortRange{54400, 54401}, PortRange{64400, 64400}, taken, func(n int) bool { return !busy[n] })
	if err != nil {
		t.Fatal(err)
	}
	if p != (Ports{API: 8202, DB: 54401, Pooler: 64400}) {
		t.Fatalf("ports = %+v", p)
	}
	if _, err := AllocatePorts(PortRange{8200, 8203}, PortRange{54400, 54401}, PortRange{64400, 64400}, taken, nil); err == nil {
		t.Fatal("allocated from a full range")
	}
}

func TestParsePublished(t *testing.T) {
	got := parsePublished("0.0.0.0:8200-8202->8200-8202/tcp, [::]:8200-8202->8200-8202/tcp\n127.0.0.1:5432->5432/tcp\n6379/tcp\n")
	for _, p := range []int{8200, 8201, 8202, 5432} {
		if !got[p] {
			t.Errorf("port %d not taken", p)
		}
	}
	if len(got) != 4 {
		t.Errorf("taken = %v", got)
	}
}

func TestOverlayReplacesWrittenBindMounts(t *testing.T) {
	// Each folder a container writes to is a named volume in the overlay,
	// at the same path in the container as the bind mount it replaces.
	compose, _ := fs.ReadFile(templateFS, "template/docker-compose.yml")
	for _, m := range []struct{ bind, volume string }{
		{"./volumes/db/data:/var/lib/postgresql/data", "db-data:/var/lib/postgresql/data"},
		{"./volumes/snippets:/app/snippets", "studio-snippets:/app/snippets"},
		{"./volumes/storage:/var/lib/storage", "storage-files:/var/lib/storage"},
	} {
		if !strings.Contains(string(compose), m.bind) {
			t.Errorf("the template no longer mounts %s; check the overlay", m.bind)
		}
		if !strings.Contains(overlay, m.volume) {
			t.Errorf("overlay lacks %s", m.volume)
		}
	}
}

func TestParsePS(t *testing.T) {
	lines := []byte(`{"Service":"db","Name":"p-db-1","State":"running","Health":"healthy","Status":"Up 2 minutes (healthy)"}
{"Service":"auth","Name":"p-auth-1","State":"exited","Health":"","Status":"Exited (1)"}
`)
	s, err := parsePS(lines)
	if err != nil || len(s) != 2 || s[0].Health != "healthy" || s[1].State != "exited" {
		t.Fatalf("parsePS = %+v, %v", s, err)
	}
	arr, err := parsePS([]byte(`[{"Service":"db","State":"running"}]`))
	if err != nil || len(arr) != 1 {
		t.Fatalf("array form = %+v, %v", arr, err)
	}
	empty, err := parsePS(nil)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty = %+v, %v", empty, err)
	}
}

func TestTailWriter(t *testing.T) {
	w := &tailWriter{max: 2}
	_, _ = w.Write([]byte("a\nb\nc"))
	_, _ = w.Write([]byte("d\n"))
	if got := w.String(); got != "b\ncd" {
		t.Fatalf("tail = %q", got)
	}
}

func TestGenerateAPIKeys(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	k, err := GenerateAPIKeys("legacy-secret", now)
	if err != nil {
		t.Fatal(err)
	}
	opaque := regexp.MustCompile(`^sb_(publishable|secret)_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{8}$`)
	for _, key := range []string{k.Publishable, k.Secret} {
		if !opaque.MatchString(key) || !OpaqueKeyValid(key) {
			t.Errorf("%q isn't a valid opaque key", key)
		}
	}
	if OpaqueKeyValid(k.Publishable[:len(k.Publishable)-1] + "x") {
		t.Error("a bad checksum passed")
	}

	// The public JWKS has the EC key (no private part) and the legacy secret.
	var jwks struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal([]byte(k.JWTJWKS), &jwks); err != nil || len(jwks.Keys) != 2 {
		t.Fatalf("JWT_JWKS = %s (%v)", k.JWTJWKS, err)
	}
	ec, oct := jwks.Keys[0], jwks.Keys[1]
	if ec["kty"] != "EC" || ec["d"] != nil || ec["alg"] != "ES256" || oct["k"] != base64.RawURLEncoding.EncodeToString([]byte("legacy-secret")) {
		t.Fatalf("JWT_JWKS keys = %v", jwks.Keys)
	}
	var private []map[string]any
	if err := json.Unmarshal([]byte(k.JWTKeys), &private); err != nil || private[0]["d"] == nil || private[0]["kid"] != ec["kid"] {
		t.Fatalf("JWT_KEYS = %s", k.JWTKeys)
	}

	// The ES256 tokens verify with the published key.
	x, _ := base64.RawURLEncoding.DecodeString(ec["x"].(string))
	y, _ := base64.RawURLEncoding.DecodeString(ec["y"].(string))
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	for role, token := range map[string]string{"anon": k.AnonAsymmetric, "service_role": k.ServiceRoleAsymmetric} {
		parts := strings.Split(token, ".")
		head, _ := base64.RawURLEncoding.DecodeString(parts[0])
		if !strings.Contains(string(head), `"kid":"`+ec["kid"].(string)+`"`) {
			t.Errorf("%s header = %s", role, head)
		}
		sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if len(sig) != 64 || !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
			t.Errorf("%s token doesn't verify", role)
		}
		payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var c apiKeyClaims
		_ = json.Unmarshal(payload, &c)
		if c.Role != role || c.Exp != now.Add(keyLifetime).Unix() {
			t.Errorf("%s claims = %+v", role, c)
		}
	}
}

func TestEnableJWKS(t *testing.T) {
	compose, _ := fs.ReadFile(templateFS, "template/docker-compose.yml")
	out, err := enableJWKS(string(compose))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"GOTRUE_JWT_KEYS: ${JWT_KEYS:-[]}", `API_JWT_JWKS: ${JWT_JWKS:-{"keys":[]}}`, "SUPABASE_JWKS: ${JWT_JWKS:-{\"keys\":[]}}"} {
		if !strings.Contains(out, "      "+want) {
			t.Errorf("not enabled: %s", want)
		}
	}
	if _, err := enableJWKS("services: {}\n"); err == nil {
		t.Error("accepted a compose file without the settings")
	}
}
