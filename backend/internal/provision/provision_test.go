package provision

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"maps"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
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
	// Change the checksum's last character (to one it isn't).
	last := "x"
	if strings.HasSuffix(k.Publishable, last) {
		last = "y"
	}
	if OpaqueKeyValid(k.Publishable[:len(k.Publishable)-1] + last) {
		t.Error("a bad checksum passed")
	}
	// Checksums can contain "_" (base64url); a key whose checksum does still checks.
	for i := 0; i < 2000; i++ {
		key, err := opaqueKey("sb_secret_")
		if err != nil || !OpaqueKeyValid(key) {
			t.Fatalf("%q didn't validate", key)
		}
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

func TestFunctions(t *testing.T) {
	stack := t.TempDir()
	if fns, err := ListFunctions(stack); err != nil || len(fns) != 0 {
		t.Fatalf("empty stack: %v %v", fns, err)
	}
	files := []FunctionFile{{"index.ts", "Deno.serve(() => new Response('v1'))\n"}, {"lib/util.ts", "export const x = 1\n"}}
	if err := WriteFunction(stack, "hello-world", files, nil); err != nil {
		t.Fatal(err)
	}
	// A binary file put there by hand is kept on the next deploy.
	bin := filepath.Join(stack, "volumes/functions/hello-world/logo.png")
	if err := os.WriteFile(bin, []byte{0x89, 'P', 'N', 'G', 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	info, got, other, err := ReadFunction(stack, "hello-world")
	if err != nil || len(got) != 2 || got[1].Path != "lib/util.ts" || len(other) != 1 || other[0] != "logo.png" || info.Entrypoint != "index.ts" {
		t.Fatalf("read: %+v %+v %v %v", info, got, other, err)
	}
	if err := WriteFunction(stack, "hello-world", []FunctionFile{{"index.ts", "v2"}}, []string{"logo.png"}); err != nil {
		t.Fatal(err)
	}
	_, got, other, _ = ReadFunction(stack, "hello-world")
	if len(got) != 1 || got[0].Content != "v2" || len(other) != 1 {
		t.Fatalf("after redeploy: %+v %v", got, other)
	}
	fns, _ := ListFunctions(stack)
	if len(fns) != 1 || fns[0].Name != "hello-world" || fns[0].Files != 2 {
		t.Fatalf("list: %+v", fns)
	}
	// Nothing left over from the swap.
	entries, _ := os.ReadDir(filepath.Join(stack, "volumes/functions"))
	if len(entries) != 1 {
		t.Errorf("functions folder: %v", entries)
	}

	for _, bad := range []struct {
		name  string
		files []FunctionFile
		keep  []string
	}{
		{"main", files, nil},
		{"-x", files, nil},
		{"ok", []FunctionFile{{"lib.ts", ""}}, nil},                     // no entrypoint
		{"ok", []FunctionFile{{"index.ts", ""}, {"../x.ts", ""}}, nil},  // escapes
		{"ok", []FunctionFile{{"index.ts", ""}, {"/etc/x", ""}}, nil},   // absolute
		{"ok", []FunctionFile{{"index.ts", ""}, {".env", ""}}, nil},     // dot file
		{"ok", []FunctionFile{{"index.ts", ""}, {"index.ts", ""}}, nil}, // twice
		{"hello-world", []FunctionFile{{"index.ts", ""}}, []string{"nope.png"}},
		{"ok", []FunctionFile{{"index.ts", strings.Repeat("x", MaxFunctionFileSize+1)}}, nil},
	} {
		if err := WriteFunction(stack, bad.name, bad.files, bad.keep); err == nil {
			t.Errorf("accepted %s %v keep %v", bad.name, bad.files, bad.keep)
		}
	}

	// Files the editor can't show are kept even when their paths break the
	// editable-path rule; paths that leave the folder never are.
	fnDir := filepath.Join(stack, "volumes/functions/hello-world")
	for _, f := range []string{".npmrc", "odd (1)~.txt"} {
		if err := os.WriteFile(filepath.Join(fnDir, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "passwd"), []byte("root:x:0:0"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(fnDir, "cfg")); err != nil {
		t.Fatal(err)
	}
	_, _, other, _ = ReadFunction(stack, "hello-world")
	if strings.Join(other, ",") != ".npmrc,cfg,logo.png,odd (1)~.txt" {
		t.Fatalf("other files = %q", other)
	}
	if err := WriteFunction(stack, "hello-world", []FunctionFile{{"index.ts", "v3"}}, other); err != nil {
		t.Fatalf("keeping the other files: %v", err)
	}
	if target, err := os.Readlink(filepath.Join(fnDir, "cfg")); err != nil || target != outside {
		t.Errorf("the kept link = %q, %v", target, err)
	}
	for _, escape := range []string{"cfg/passwd", "../hello-world/index.ts", "/etc/passwd"} {
		if err := WriteFunction(stack, "hello-world", []FunctionFile{{"index.ts", "v4"}}, []string{escape}); err == nil {
			t.Errorf("kept %s, from outside the function", escape)
		}
	}
	if err := WriteFunction(stack, "secrets", files, nil); err == nil {
		t.Error("accepted a function named secrets")
	}

	if err := DeleteFunction(stack, "hello-world"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteFunction(stack, "hello-world"); !errors.Is(err, ErrNoFunction) {
		t.Errorf("deleting twice: %v", err)
	}
}

var trickySecrets = map[string]string{
	"PLAIN":  "abc123",
	"DOLLAR": "pa$$word ${HOME} $HOME",
	"QUOTES": `say "hi" and 'bye'`,
	"SLASH":  `C:\path\n not a newline`,
	"MULTI":  "-----BEGIN KEY-----\nline2\r\n\tindented\n-----END KEY-----",
	"HASH":   "#not a comment = still value",
	"EMPTY":  "",
	"UNI":    "héllo ✓",
}

func TestFunctionSecretsRoundTrip(t *testing.T) {
	stack := t.TempDir()
	if err := WriteFunctionSecrets(stack, trickySecrets); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFunctionSecrets(stack)
	if err != nil || !maps.Equal(got, trickySecrets) {
		t.Fatalf("round trip: %q %v", got, err)
	}
	if fi, _ := os.Stat(filepath.Join(stack, functionSecretsFile)); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode())
	}
	for v, ok := range map[string]bool{"plain": true, "tab\tand\nlines\r\n": true, "nul\x00": false, "bell\a": false, "del\x7f": false, "\xff\xfe": false} {
		if (ValidSecretValue("K", v) == nil) != ok {
			t.Errorf("%q: want valid=%v", v, ok)
		}
	}
	// Edited by hand: read, not refused.
	hand := "# by hand\r\nA=plain value # comment\r\nexport B='single $x'\nC=pa$$word\nnot a setting\nD=\"quoted\\nline\"\n"
	if err := os.WriteFile(filepath.Join(stack, functionSecretsFile), []byte(hand), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = ReadFunctionSecrets(stack)
	want := map[string]string{"A": "plain value", "B": "single $x", "C": "pa$word", "D": "quoted\nline"}
	if err != nil || !maps.Equal(got, want) {
		t.Errorf("hand-edited file = %q, %v", got, err)
	}
	for name, ok := range map[string]bool{"API_KEY": true, "_x": true, "SUPABASE_URL": false, "sb_x": false, "JWT_SECRET": false, "1X": false, "A-B": false} {
		if (ValidSecretName(name) == nil) != ok {
			t.Errorf("%s: want valid=%v", name, ok)
		}
	}
}

// Compose itself reads the values back unchanged (needs the docker CLI).
func TestFunctionSecretsAsComposeReadsThem(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("no docker CLI")
	}
	dir := t.TempDir()
	if err := WriteFunctionSecrets(dir, trickySecrets); err != nil {
		t.Fatal(err)
	}
	compose := "services:\n  t:\n    image: alpine\n    env_file:\n      - ./functions.env\n"
	if err := os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("docker", "compose", "config", "--format", "json")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Skipf("docker compose config: %v", err)
	}
	var cfg struct {
		Services map[string]struct {
			Environment map[string]*string `json:"environment"`
		} `json:"services"`
	}
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	for k, want := range trickySecrets {
		got := cfg.Services["t"].Environment[k]
		// config's output escapes $ as $$ again; the container gets single ones.
		if got == nil || strings.ReplaceAll(*got, "$$", "$") != want {
			t.Errorf("%s: compose read %q, want %q", k, deref(got), want)
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func TestFunctionsDontGetTheJWTSecret(t *testing.T) {
	router, _ := fs.ReadFile(templateFS, "template/volumes/functions/main/index.ts")
	out, err := hideJWTSecret(string(router))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, workerEnvLine) ||
		!strings.Contains(out, "const { JWT_SECRET: _routerOnly, SUPERMIXER_FUNCTIONS_ADMIN_ACCESS: adminAccess, ...workerEnv } = Deno.env.toObject()") ||
		!strings.Contains(out, "delete workerEnv.SUPABASE_SERVICE_ROLE_KEY") || !strings.Contains(out, "delete workerEnv.SUPABASE_DB_URL") {
		t.Errorf("router not patched")
	}
	// Patching again changes nothing; an older stack's patch is brought up to date.
	if again, err := hideJWTSecret(out); err != nil || again != out {
		t.Errorf("patching twice: %v", err)
	}
	older := strings.Replace(string(router), workerEnvLine, workerEnvHiddenV1, 1)
	if up, err := hideJWTSecret(older); err != nil || up != out {
		t.Errorf("upgrading an older patch: %v", err)
	}
	// The router itself still reads it.
	if !strings.Contains(out, "const JWT_SECRET = Deno.env.get('JWT_SECRET')") {
		t.Error("the router no longer reads JWT_SECRET")
	}
	if _, err := hideJWTSecret("Deno.serve(() => {})"); err == nil {
		t.Error("patched a router it doesn't recognise")
	}
}

func TestWrittenStacksHaveFunctionSecretsFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "s")
	if err := WriteStack(Layout{Dir: dir, Project: "supermixer-x"}, map[string]string{}); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(filepath.Join(dir, functionSecretsFile)); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("functions.env: %v %v", fi, err)
	}
	router, _ := os.ReadFile(filepath.Join(dir, "volumes/functions/main/index.ts"))
	if !strings.Contains(string(router), "...workerEnv") {
		t.Error("the written router still gives functions JWT_SECRET")
	}
	// The plain env_file form works on every Compose v2.
	if strings.Contains(overlay, "required:") || !strings.Contains(overlay, "      - ./functions.env\n") {
		t.Errorf("overlay env_file:\n%s", overlay)
	}
}

// Older templates stored the JWT secret as a database setting, readable by
// every role; an update must not bring that back.
func TestTemplateDoesntStoreTheJWTSecretInTheDatabase(t *testing.T) {
	err := fs.WalkDir(templateFS, "template", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, _ := fs.ReadFile(templateFS, p)
		if regexp.MustCompile(`(?i)app\.settings\.jwt_secret`).Match(b) {
			t.Errorf("%s mentions app.settings.jwt_secret", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestOldStacksArePrepared(t *testing.T) {
	dir := t.TempDir()
	// A .env from before the functions' database login existed.
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("POSTGRES_PASSWORD=abc123\nPOSTGRES_HOST=db\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services:\n  studio:\n    image: supabase/studio:x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PrepareStack(dir); err != nil {
		t.Fatal(err)
	}
	env, _ := ReadEnv(dir)
	if !hexPassword.MatchString(env["FUNCTIONS_DB_PASSWORD"]) || env["FUNCTIONS_DB_LOGIN"] != "functions_user:"+env["FUNCTIONS_DB_PASSWORD"] {
		t.Fatalf("env = %v", env)
	}
	if env["POSTGRES_PASSWORD"] != "abc123" || FunctionsDBAccessOf(env) != DBAccessServiceRole {
		t.Errorf("env = %v", env)
	}
	if _, err := os.Stat(filepath.Join(dir, functionSecretsFile)); err != nil {
		t.Error("no functions.env")
	}
	// Preparing again changes nothing.
	before, _ := os.ReadFile(filepath.Join(dir, ".env"))
	_ = PrepareStack(dir)
	after, _ := os.ReadFile(filepath.Join(dir, ".env"))
	if string(before) != string(after) {
		t.Error("preparing twice changed .env")
	}
	if FunctionsDBLogin(DBAccessPostgres, env) != "postgres:abc123" {
		t.Error("postgres login")
	}
	if err := (Compose{}).EnsureFunctionsRole(context.Background(), nil, "x'; drop role postgres; --"); err == nil {
		t.Error("used a password that isn't hex")
	}
}

// What Compose gives the functions service, from a written stack (needs the docker CLI).
func TestFunctionsDatabaseURLAsComposeResolvesIt(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("no docker CLI")
	}
	dir := filepath.Join(t.TempDir(), "s")
	secrets, _ := GenerateSecrets(time.Now())
	if err := WriteStack(Layout{Dir: dir, Project: "supermixer-x"}, secrets.Env()); err != nil {
		t.Fatal(err)
	}
	if err := PrepareStack(dir); err != nil {
		t.Fatal(err)
	}
	url := func() string {
		cmd := exec.Command("docker", "compose", "config", "--format", "json")
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			t.Skipf("docker compose config: %v", err)
		}
		var cfg struct {
			Services map[string]struct {
				Environment map[string]*string `json:"environment"`
			} `json:"services"`
		}
		if err := json.Unmarshal(out, &cfg); err != nil {
			t.Fatal(err)
		}
		return deref(cfg.Services["functions"].Environment["SUPABASE_DB_URL"])
	}
	want := "postgresql://functions_user:" + secrets.FunctionsDBPassword + "@db:5432/postgres"
	if got := url(); got != want {
		t.Fatalf("SUPABASE_DB_URL = %q, want functions_user's", got)
	}
	env, _ := ReadEnv(dir)
	if err := UpdateEnv(dir, map[string]string{"FUNCTIONS_DB_LOGIN": FunctionsDBLogin(DBAccessPostgres, env)}); err != nil {
		t.Fatal(err)
	}
	if got := url(); got != "postgresql://postgres:"+secrets.PostgresPassword+"@db:5432/postgres" {
		t.Fatalf("after choosing postgres: %q", got)
	}
}

func writtenStack(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "s")
	secrets, _ := GenerateSecrets(time.Now())
	env := secrets.Env()
	env["API_EXTERNAL_URL"] = "http://stacks.example:8201"
	if err := WriteStack(Layout{Dir: dir, Project: "supermixer-x"}, env); err != nil {
		t.Fatal(err)
	}
	if err := PrepareStack(dir); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestAuthConfig(t *testing.T) {
	dir := writtenStack(t)
	cfg, err := ReadAuthConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Defaults: .env-wired settings have the example's values; the rest are unset.
	if cfg.Values["site_url"] != "http://localhost:3000" || cfg.Values["disable_signup"] != false || cfg.Values["sessions_timebox"] != nil {
		t.Fatalf("defaults: site_url=%v disable_signup=%v sessions_timebox=%v", cfg.Values["site_url"], cfg.Values["disable_signup"], cfg.Values["sessions_timebox"])
	}

	changed, err := ApplyAuthChanges(dir, []AuthChange{
		{"site_url", "https://app.example.com"},
		{"uri_allow_list", " https://app.example.com/**, http://localhost:3000/* ,"},
		{"disable_signup", true},
		{"sessions_timebox", float64(86400)},
		{"rate_limit_email_sent", float64(2.5)},
		{"external_github_enabled", true},
		{"external_github_client_id", "abc"},
		{"external_github_secret", "shh"},
		{"smtp_pass", "mail-pass"},
		{"mailer_subjects_invite", "Join us"},
		{"mailer_templates_invite_content", "<h2>Hi</h2><a href=\"{{ .ConfirmationURL }}\">Accept</a>"},
		{"hook_custom_access_token_uri", "pg-functions://postgres/public/claims_hook"},
		{"hook_send_email_secrets", "v1,whsec_VGhpcyBpcyBhbiBleGFtcGxlIG9mIGEgc2hvcnRlcg=="},
	})
	if err != nil || len(changed) != 13 {
		t.Fatalf("apply: %v %v", changed, err)
	}
	cfg, _ = ReadAuthConfig(dir)
	want := map[string]any{
		"site_url": "https://app.example.com", "uri_allow_list": "https://app.example.com/**,http://localhost:3000/*",
		"disable_signup": true, "sessions_timebox": float64(86400), "rate_limit_email_sent": 2.5,
		"external_github_enabled": true, "external_github_client_id": "abc", "mailer_subjects_invite": "Join us",
	}
	for k, v := range want {
		if cfg.Values[k] != v {
			t.Errorf("%s = %#v, want %#v", k, cfg.Values[k], v)
		}
	}
	// Secrets are reported as set, never returned.
	if _, ok := cfg.Values["external_github_secret"]; ok || !slices.Contains(cfg.SecretsSet, "external_github_secret") ||
		!slices.Contains(cfg.SecretsSet, "smtp_pass") || !slices.Contains(cfg.SecretsSet, "hook_send_email_secrets") {
		t.Errorf("secrets: %v, values has github secret: %v", cfg.SecretsSet, cfg.Values["external_github_secret"])
	}
	auth, _ := readEnvFile(filepath.Join(dir, authEnvFile))
	// Callback URLs come from the overlay (following API_EXTERNAL_URL), not auth.env.
	if auth["GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI"] != "" ||
		auth["GOTRUE_SESSIONS_TIMEBOX"] != "86400s" ||
		auth["GOTRUE_MAILER_TEMPLATES_INVITE"] != "http://auth-templates:8080/invite.html" {
		t.Errorf("auth.env = %v", auth)
	}
	if fi, _ := os.Stat(filepath.Join(dir, authEnvFile)); fi.Mode().Perm() != 0o600 {
		t.Errorf("auth.env mode %v", fi.Mode())
	}

	// Back to defaults; the SMTP login is emptied, not set to the example's fake one.
	if _, err := ApplyAuthChanges(dir, []AuthChange{{"site_url", nil}, {"external_github_enabled", nil}, {"mailer_templates_invite_content", nil}, {"smtp_pass", nil}}); err != nil {
		t.Fatal(err)
	}
	cfg, _ = ReadAuthConfig(dir)
	if slices.Contains(cfg.SecretsSet, "smtp_pass") {
		t.Error("smtp_pass still set after removing it")
	}
	auth, _ = readEnvFile(filepath.Join(dir, authEnvFile))
	if cfg.Values["site_url"] != "http://localhost:3000" || cfg.Values["external_github_enabled"] != nil ||
		auth["GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI"] != "" || auth["GOTRUE_MAILER_TEMPLATES_INVITE"] != "" {
		t.Errorf("after reset: site_url=%v github=%v auth.env=%v", cfg.Values["site_url"], cfg.Values["external_github_enabled"], auth)
	}

	for _, bad := range []AuthChange{
		{"nope", true}, {"disable_signup", "yes"}, {"site_url", "ftp://x"}, {"site_url", "https://x\nEVIL=1"},
		{"sessions_timebox", float64(-1)}, {"sessions_timebox", 1.5}, {"smtp_port", float64(70000)},
		{"sms_provider", "carrier-pigeon"}, {"hook_send_email_secrets", "hunter2"},
		{"hook_custom_access_token_uri", "pg-functions://postgres/public; drop table x"},
		{"uri_allow_list", "not a url"}, {"smtp_admin_email", "nobody"},
	} {
		if err := ValidateAuthChanges([]AuthChange{bad}); err == nil {
			t.Errorf("accepted %v = %#v", bad.Name, bad.Value)
		}
	}
	// Combinations Auth would refuse at startup.
	for _, bad := range [][]AuthChange{
		{{"hook_send_email_enabled", true}}, // no target
		{{"hook_send_sms_enabled", true}, {"hook_send_sms_uri", "https://hooks.example.com/sms"}}, // no secret
		{{"security_captcha_enabled", true}, {"security_captcha_secret", "s"}},                    // no provider
		{{"security_captcha_enabled", true}, {"security_captcha_provider", "turnstile"}},          // no secret
	} {
		if _, err := ApplyAuthChanges(dir, bad); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
	if _, err := ApplyAuthChanges(dir, []AuthChange{{"hook_custom_access_token_enabled", true}}); err != nil {
		t.Errorf("a pg-functions hook with a target was refused: %v", err) // its URI was set above
	}
	if _, err := ApplyAuthChanges(dir, []AuthChange{{"security_captcha_enabled", true}, {"security_captcha_provider", "turnstile"}, {"security_captcha_secret", "s"}}); err != nil {
		t.Errorf("complete CAPTCHA settings were refused: %v", err)
	}
	for _, uri := range []string{"http://functions:9000/email", "http://hooks.example.com/x"} {
		if err := ValidateAuthChanges([]AuthChange{{"hook_send_email_uri", uri}}); err == nil {
			t.Errorf("accepted plain http hook %s", uri)
		}
	}
	if err := ValidateAuthChanges([]AuthChange{{"hook_send_email_uri", "http://host.docker.internal:54321/functions/v1/email"}}); err != nil {
		t.Errorf("refused http to host.docker.internal: %v", err)
	}

	if _, err := ApplyAuthChanges(dir, []AuthChange{{"disable_signup", false}, {"site_url", "ftp://x"}}); err == nil {
		t.Error("applied a batch with an invalid value")
	} else if cfg2, _ := ReadAuthConfig(dir); cfg2.Values["disable_signup"] != true {
		t.Error("a rejected batch was partly applied")
	}
}

// What Compose gives the auth service and the template server (needs the docker CLI).
func TestAuthConfigAsComposeResolvesIt(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("no docker CLI")
	}
	dir := writtenStack(t)
	tricky := `pa$sw0rd ${HOME} #1 "q" \x`
	if _, err := ApplyAuthChanges(dir, []AuthChange{
		{"site_url", "https://app.example.com"}, {"external_google_enabled", true}, {"mailer_templates_recovery_content", "<p>Reset</p>"},
		{"smtp_pass", tricky}, {"smtp_sender_name", "Acme #1 Support"},
	}); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("docker", "compose", "config", "--format", "json")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Skipf("docker compose config: %v", err)
	}
	var cfg struct {
		Services map[string]struct {
			Image       string             `json:"image"`
			Entrypoint  []string           `json:"entrypoint"`
			Environment map[string]*string `json:"environment"`
			Healthcheck struct {
				Test []string `json:"test"`
			} `json:"healthcheck"`
		} `json:"services"`
	}
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	auth := cfg.Services["auth"].Environment
	for k, v := range map[string]string{
		"GOTRUE_SITE_URL":                     "https://app.example.com",
		"GOTRUE_EXTERNAL_GOOGLE_ENABLED":      "true",
		"GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI": "http://stacks.example:8201/callback",
		"GOTRUE_MAILER_TEMPLATES_RECOVERY":    "http://auth-templates:8080/recovery.html",
		"GOTRUE_SMTP_PASS":                    tricky,
		"GOTRUE_SMTP_SENDER_NAME":             "Acme #1 Support",
	} {
		// config's output escapes $ as $$ again; the container gets single ones.
		if strings.ReplaceAll(deref(auth[k]), "$$", "$") != v {
			t.Errorf("auth %s = %q, want %q", k, deref(auth[k]), v)
		}
	}
	tpl := cfg.Services["auth-templates"]
	studio := cfg.Services["studio"]
	// Its own healthcheck: Studio's image's would never pass, failing `up --wait`.
	if len(tpl.Healthcheck.Test) < 2 || !strings.Contains(strings.Join(tpl.Healthcheck.Test, " "), "127.0.0.1:8080") {
		t.Errorf("auth-templates healthcheck = %v", tpl.Healthcheck.Test)
	}
	if tpl.Image == "" || tpl.Image != studio.Image || len(tpl.Entrypoint) != 3 || tpl.Entrypoint[0] != "node" {
		t.Errorf("auth-templates = %+v", tpl)
	}
}

func TestOverlayWithoutStudioInCompose(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("POSTGRES_PASSWORD=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services:\n  db:\n    image: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := PrepareStack(dir); err != nil {
		t.Fatalf("a compose file without studio: %v", err)
	}
	compose, _ := fs.ReadFile(templateFS, "template/docker-compose.yml")
	bundled, _ := imageIn(compose, "studio")
	o, _ := os.ReadFile(filepath.Join(dir, overlayName))
	if bundled == "" || !strings.Contains(string(o), "image: "+bundled) {
		t.Errorf("overlay doesn't use the bundled Studio image %q", bundled)
	}
}

// A stack's router is brought up to date when its overlay is refreshed; one
// changed by hand is left alone unless admin access is off, which needs it.
func TestEnsureRouterPatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, filepath.FromSlash(routerFile))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	router, _ := fs.ReadFile(templateFS, "template/volumes/functions/main/index.ts")
	older := strings.Replace(string(router), workerEnvLine, workerEnvHiddenV1, 1)
	if err := os.WriteFile(path, []byte(older), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureRouterPatch(dir, true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), workerEnvHidden) {
		t.Error("older patch not upgraded")
	}
	if err := os.WriteFile(path, []byte("Deno.serve(() => new Response('mine'))"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureRouterPatch(dir, true); err != nil {
		t.Errorf("a router changed by hand, admin access on: %v", err)
	}
	if err := ensureRouterPatch(dir, false); err == nil {
		t.Error("admin access off with a router it can't patch")
	}
	if b, _ := os.ReadFile(path); string(b) != "Deno.serve(() => new Response('mine'))" {
		t.Error("a router changed by hand was rewritten")
	}
}
