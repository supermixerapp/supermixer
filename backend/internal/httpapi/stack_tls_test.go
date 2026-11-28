package httpapi

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"supermixer/internal/config"
	"supermixer/internal/provision"
	"supermixer/internal/stack"
	"supermixer/internal/tlscert"
)

// testCA writes a CA and a certificate from it for names into dir, and
// returns their paths: certificate, key, CA.
func testCA(t *testing.T, dir string, names ...string) (string, string, string) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	ca, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: names[0]}, DNSNames: names,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(12 * time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalPKCS8PrivateKey(key)
	write := func(name, typ string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: b}), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	return write("cert.pem", "CERTIFICATE", der), write("key.pem", "PRIVATE KEY", kder), write("ca.pem", "CERTIFICATE", caDER)
}

func TestStackTLS(t *testing.T) {
	stacks := t.TempDir()
	t.Setenv("FAKE_DOCKER_LOG", filepath.Join(t.TempDir(), "docker.log"))
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	certFile, keyFile, caFile := testCA(t, t.TempDir(), "stacks.example")
	configure := func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.Docker = fake
		c.Provisioning.PublicHost = "stacks.example"
		c.Provisioning.APIPorts = "8200-8203"
		c.Provisioning.DBPorts = "54400-54403"
		c.Provisioning.PoolerPorts = "64400-64403"
		c.TLS = config.TLS{Mode: config.TLSFiles, CertFile: certFile, KeyFile: keyFile, CAFile: caFile}
	}
	withTLS := func(d *Deps) {
		m, err := tlscert.New(d.Config, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatal(err)
		}
		d.TLS = m
	}
	env := newTestEnvDeps(t, testDatabase(t), configure, withTLS)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Stacks"}, nil)

	var ui struct{ Provisioning struct{ TLS bool } }
	admin.must(200, "GET", "/ui-config", nil, &ui)
	if !ui.Provisioning.TLS {
		t.Error("ui-config doesn't say stacks can use TLS")
	}

	type project struct {
		Ref      string
		APIURL   string `json:"api_url"`
		Database struct{ Host, Sslmode, Sslrootcert, URI string }
		Stack    *struct{ TLS bool }
	}
	getProject := func(ref string) project {
		t.Helper()
		var out project // fresh: null fields stay empty
		admin.must(200, "GET", "/projects/"+ref, nil, &out)
		return out
	}
	// New stacks use TLS.
	var p project
	admin.must(202, "POST", "/organizations/stacks/projects/new-stack", map[string]string{"name": "Secure"}, &p)
	if s := waitStack(t, admin, p.Ref); !s.TLS {
		t.Errorf("stack detail says no TLS: %+v", s)
	}
	p = getProject(p.Ref)
	if p.APIURL != "https://stacks.example:8201" || p.Database.Sslmode != "verify-full" || p.Database.Sslrootcert != "download" ||
		strings.Contains(p.Database.URI, "sslrootcert") || p.Stack == nil || !p.Stack.TLS {
		t.Fatalf("project = %+v", p)
	}
	dir := filepath.Join(stacks, p.Ref)
	e := mustEnv(t, dir)
	if !provision.TLSOf(e) || e["SUPABASE_PUBLIC_URL"] != "https://stacks.example:8201" || e["API_EXTERNAL_URL"] != "https://stacks.example:8201/auth/v1" {
		t.Errorf(".env: TLS %q, URLs %q %q", e[provision.TLSEnv], e["SUPABASE_PUBLIC_URL"], e["API_EXTERNAL_URL"])
	}
	if overlay, _ := os.ReadFile(filepath.Join(dir, "supermixer.yml")); !strings.Contains(string(overlay), "lds.tls.template.yaml") {
		t.Error("overlay has no TLS listener")
	}
	if _, err := os.Stat(filepath.Join(stacks, tlscert.ExportDirName, tlscert.FullchainFile)); err != nil {
		t.Errorf("certificate not written for the stacks: %v", err)
	}

	// Anyone can download the CA to trust it.
	resp := env.client(t).raw("GET", "/tls/ca.pem")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	ca, _ := os.ReadFile(caFile)
	if resp.StatusCode != 200 || string(body) != string(ca) {
		t.Errorf("ca.pem: %d %q", resp.StatusCode, body)
	}

	// Turning it off and on again, on a running stack.
	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/tls", map[string]bool{"enabled": false}, nil)
	if s := waitStack(t, admin, p.Ref); s.TLS {
		t.Errorf("stack detail still says TLS: %+v", s)
	}
	p = getProject(p.Ref)
	if p.APIURL != "http://stacks.example:8201" || p.Database.Sslmode != "disable" || p.Database.Sslrootcert != "" || p.Stack.TLS {
		t.Fatalf("after turning TLS off: %+v", p)
	}
	if provision.TLSOf(mustEnv(t, dir)) {
		t.Error(".env still says TLS")
	}

	// Compose too old for the overlay's !override (checked once per
	// start): refused, nothing changes.
	t.Setenv("FAKE_COMPOSE_VERSION", "2.24.3")
	old := newTestEnvDeps(t, env.dbURL, configure, withTLS).client(t)
	old.signIn("admin", adminPassword)
	var refused struct{ Message string }
	if code := old.do("PUT", "/projects/"+p.Ref+"/stack/tls", map[string]bool{"enabled": true}, &refused); code == 202 ||
		!strings.Contains(refused.Message, "2.24.4 or later") {
		t.Errorf("Compose 2.24.3: %d %q", code, refused.Message)
	}
	t.Setenv("FAKE_COMPOSE_VERSION", "2.29.1")

	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/tls", map[string]bool{"enabled": true}, nil)
	waitStack(t, admin, p.Ref)
	p = getProject(p.Ref)
	if p.APIURL != "https://stacks.example:8201" || !p.Stack.TLS {
		t.Fatalf("after turning TLS on: %+v", p)
	}

	// A paused stack: the files and addresses change now.
	admin.must(202, "POST", "/projects/"+p.Ref+"/stack/stop", nil, nil)
	waitStack(t, admin, p.Ref)
	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/tls", map[string]bool{"enabled": false}, nil)
	p = getProject(p.Ref)
	if p.APIURL != "http://stacks.example:8201" || p.Stack.TLS {
		t.Fatalf("paused, after turning TLS off: %+v", p)
	}

	// With [tls] turned off in the settings, a stack that used TLS goes
	// back to plain HTTP when it next starts: nothing would renew its
	// certificate.
	admin.must(202, "PUT", "/projects/"+p.Ref+"/stack/tls", map[string]bool{"enabled": true}, nil)
	plain := newTestEnvSharing(t, env, func(c *config.Config) {
		configure(c)
		c.TLS = config.TLS{Mode: config.TLSOff}
	}).client(t)
	plain.signIn("admin", adminPassword)
	plain.must(202, "POST", "/projects/"+p.Ref+"/stack/start", nil, nil)
	if s := waitStack(t, plain, p.Ref); s.Status != "running" {
		t.Fatalf("starting without a certificate: %+v", s)
	}
	var after project
	plain.must(200, "GET", "/projects/"+p.Ref, nil, &after)
	if after.APIURL != "http://stacks.example:8201" || after.Stack.TLS || provision.TLSOf(mustEnv(t, dir)) {
		t.Errorf("started without a certificate: %+v", after)
	}
}

func TestStackTLSNeedsACertificate(t *testing.T) {
	stacks := t.TempDir()
	t.Setenv("FAKE_DOCKER_LOG", filepath.Join(t.TempDir(), "docker.log"))
	fake, _ := filepath.Abs("testdata/fake-docker.sh")
	env := newTestEnvWith(t, func(c *config.Config) {
		c.Provisioning.Enabled = true
		c.Provisioning.StacksDir = stacks
		c.Provisioning.Docker = fake
		c.Provisioning.PublicHost = "stacks.example"
		c.Provisioning.APIPorts = "8200-8203"
		c.Provisioning.DBPorts = "54400-54403"
		c.Provisioning.PoolerPorts = "64400-64403"
	})
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Stacks"}, nil)
	var p struct{ Ref string }
	admin.must(202, "POST", "/organizations/stacks/projects/new-stack", map[string]string{"name": "Plain"}, &p)
	waitStack(t, admin, p.Ref)
	admin.must(409, "PUT", "/projects/"+p.Ref+"/stack/tls", map[string]bool{"enabled": true}, nil)
	if code := env.client(t).raw("GET", "/tls/ca.pem").StatusCode; code != 404 {
		t.Errorf("ca.pem without a CA: %d", code)
	}
}

// What a stack's Postgres port serves, after SSLRequest, as the
// certificate refresh checks it.
func TestServedPostgres(t *testing.T) {
	certFile, keyFile, _ := testCA(t, t.TempDir(), "stacks.example")
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				req := make([]byte, 8)
				if _, err := io.ReadFull(conn, req); err != nil || binary.BigEndian.Uint32(req[4:]) != 80877103 {
					return
				}
				_, _ = conn.Write([]byte("S"))
				_ = tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{pair}}).Handshake()
			}()
		}
	}()
	cfg := config.Default()
	h := &handlers{deps: Deps{Config: &cfg}, network: stack.NewNetwork(map[string]string{"stacks.example": "127.0.0.1"}, nil, nil)}
	port := ln.Addr().(*net.TCPAddr).Port
	got, err := h.servedPostgres(t.Context(), "stacks.example", port)
	if err != nil || string(got) != string(pair.Certificate[0]) {
		t.Fatalf("served %d bytes, %v", len(got), err)
	}
}
