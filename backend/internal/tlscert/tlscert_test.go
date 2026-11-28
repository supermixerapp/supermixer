package tlscert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/caddyserver/certmagic"

	"supermixer/internal/config"
)

type ca struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newCA(t *testing.T, name string) *ca {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name, Organization: []string{"Test"}},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return &ca{c, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

// issue makes a certificate for names, signed by c (nil: self-signed), and
// returns it and its key as PEM.
func (c *ca) issue(t *testing.T, names ...string) (certPEM, keyPEM []byte) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: names[0]},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(12 * time.Hour),
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature,
	}
	for _, n := range names {
		if ip := net.ParseIP(n); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, n)
		}
	}
	parent, signer := tmpl, key
	if c != nil {
		parent, signer = c.cert, c.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalPKCS8PrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kder})
}

func writeFile(t *testing.T, path string, b []byte) string {
	t.Helper()
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

// filesConfig is files mode for https://sm.test and stacks on db.test.
func filesConfig(t *testing.T, dir string, certPEM, keyPEM, caPEM []byte) *config.Config {
	t.Helper()
	cfg := config.Default()
	cfg.Server.PublicURL = "https://sm.test"
	cfg.Provisioning.Enabled = true
	cfg.Provisioning.PublicHost = "db.test"
	cfg.Provisioning.StacksDir = filepath.Join(dir, "stacks")
	cfg.TLS = config.TLS{
		Mode:     config.TLSFiles,
		CertFile: writeFile(t, filepath.Join(dir, "cert.pem"), certPEM),
		KeyFile:  writeFile(t, filepath.Join(dir, "key.pem"), keyPEM),
	}
	if caPEM != nil {
		cfg.TLS.CAFile = writeFile(t, filepath.Join(dir, "ca.pem"), caPEM)
	}
	return &cfg
}

func TestOff(t *testing.T) {
	cfg := config.Default()
	m, err := New(&cfg, quiet)
	if err != nil || m != nil {
		t.Fatalf("New = %v, %v", m, err)
	}
	// A nil manager is TLS off, and safe to use.
	if m.Enabled() || m.Ready("x") || m.ServerTLSConfig() != nil || m.Status().Mode != "off" || m.Export() != nil {
		t.Error("nil manager isn't off")
	}
}

func TestFilesPrivateCA(t *testing.T) {
	dir := t.TempDir()
	c := newCA(t, "Test CA")
	cert, key := c.issue(t, "sm.test", "db.test")
	m, err := New(filesConfig(t, dir, cert, key, c.pem), quiet)
	if err != nil {
		t.Fatal(err)
	}
	if !m.Ready("sm.test") || !m.Ready("DB.test") || !m.PrivateCA() {
		t.Errorf("ready: %v %v, private %v", m.Ready("sm.test"), m.Ready("db.test"), m.PrivateCA())
	}
	s := m.Status()
	if len(s.Certs) != 1 || s.Certs[0].Issuer != "Test (Test CA)" || len(s.Missing) != 0 {
		t.Errorf("status %+v", s)
	}

	// A client trusting the CA can talk to a server using the manager.
	ln, err := tls.Listen("tcp", "127.0.0.1:0", m.ServerTLSConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			_ = conn.(*tls.Conn).Handshake()
			conn.Close()
		}
	}()
	conn, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{ServerName: "db.test", RootCAs: m.RootCAs()})
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	if !m.Issued(conn.ConnectionState().PeerCertificates[0].Raw) {
		t.Error("Issued doesn't know its own certificate")
	}
	conn.Close()
}

func TestFilesSelfSigned(t *testing.T) {
	// A self-signed certificate is its own CA.
	cert, key := (*ca)(nil).issue(t, "sm.test", "db.test")
	if _, err := New(filesConfig(t, t.TempDir(), cert, key, cert), quiet); err != nil {
		t.Fatal(err)
	}
}

func TestFilesErrors(t *testing.T) {
	c, other := newCA(t, "Test CA"), newCA(t, "Other CA")
	cert, key := c.issue(t, "sm.test", "db.test")
	short, shortKey := c.issue(t, "sm.test")
	_, otherKey := c.issue(t, "sm.test", "db.test")
	for _, tc := range []struct {
		name            string
		cert, key, caPE []byte
		want            string
	}{
		{"name missing", short, shortKey, c.pem, "doesn't cover db.test (it covers sm.test)"},
		{"private CA without ca_file", cert, key, nil, "isn't from a CA this system trusts"},
		{"wrong CA", cert, key, other.pem, "doesn't check out against tls.ca_file"},
		{"key doesn't match", cert, otherKey, c.pem, "tls.cert_file and tls.key_file"},
		{"not a CA file", cert, key, []byte("nope"), "has no PEM certificates"},
	} {
		_, err := New(filesConfig(t, t.TempDir(), tc.cert, tc.key, tc.caPE), quiet)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want %q", tc.name, err, tc.want)
		}
	}
}

func TestFilesReload(t *testing.T) {
	dir := t.TempDir()
	c := newCA(t, "Test CA")
	cert1, key1 := c.issue(t, "sm.test", "db.test")
	cfg := filesConfig(t, dir, cert1, key1, c.pem)

	// The files are links to a folder that's swapped, as certbot and
	// Kubernetes secrets do.
	live := func(name string, cert, key []byte) {
		d := filepath.Join(dir, name)
		_ = os.Mkdir(d, 0o700)
		writeFile(t, filepath.Join(d, "cert.pem"), cert)
		writeFile(t, filepath.Join(d, "key.pem"), key)
		tmp := filepath.Join(dir, "live.tmp")
		_ = os.Remove(tmp)
		if err := os.Symlink(d, tmp); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, filepath.Join(dir, "live")); err != nil {
			t.Fatal(err)
		}
	}
	live("v1", cert1, key1)
	cfg.TLS.CertFile, cfg.TLS.KeyFile = filepath.Join(dir, "live", "cert.pem"), filepath.Join(dir, "live", "key.pem")
	m, err := New(cfg, quiet)
	if err != nil {
		t.Fatal(err)
	}
	m.filesRetry = time.Millisecond
	changes := 0
	m.OnChange(func() { changes++ })
	first := m.Certificate("sm.test").Certificate[0]

	m.reloadFiles() // unchanged: nothing happens
	if changes != 0 {
		t.Fatalf("%d changes for the same files", changes)
	}

	cert2, key2 := c.issue(t, "sm.test", "db.test")
	live("v2", cert2, key2)
	m.reloadFiles()
	if changes != 1 || string(m.Certificate("sm.test").Certificate[0]) == string(first) {
		t.Fatalf("not reloaded: %d changes", changes)
	}
	second := m.Certificate("sm.test").Certificate[0]

	// A broken pair keeps the certificate in use, and says why.
	_, key3 := c.issue(t, "sm.test", "db.test")
	live("v3", cert2, key3)
	m.reloadFiles()
	if changes != 1 || string(m.Certificate("sm.test").Certificate[0]) != string(second) {
		t.Fatal("a broken pair replaced the certificate")
	}
	failedAt := m.Status().LastErrorAt
	if s := m.Status(); !strings.Contains(s.LastError, "tls.cert_file and tls.key_file") {
		t.Errorf("last error %q", s.LastError)
	}
	// The same broken files aren't tried, and reported, again.
	time.Sleep(10 * time.Millisecond)
	m.reloadFiles()
	if !m.Status().LastErrorAt.Equal(failedAt) {
		t.Error("the same broken pair was reported again")
	}

	// Fixing it clears the error.
	cert4, key4 := c.issue(t, "sm.test", "db.test")
	live("v4", cert4, key4)
	m.reloadFiles()
	if changes != 2 || m.Status().LastError != "" {
		t.Errorf("%d changes, error %q", changes, m.Status().LastError)
	}
}

func TestExport(t *testing.T) {
	dir := t.TempDir()
	c := newCA(t, "Test CA")
	cert, key := c.issue(t, "sm.test", "db.test")
	cfg := filesConfig(t, dir, cert, key, c.pem)
	m, err := New(cfg, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Export(); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(cfg.Provisioning.StacksDir, ExportDirName)
	read := func(name string) []byte {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(out, name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	pair, err := tls.X509KeyPair(read(FullchainFile), read(KeyFile))
	if err != nil {
		t.Fatalf("exported pair: %v", err)
	}
	if string(pair.Certificate[0]) != string(m.Certificate("db.test").Certificate[0]) {
		t.Error("exported a different certificate")
	}
	if string(read(CAFile)) != string(c.pem) {
		t.Error("CA not exported")
	}
	if s := string(read(SDSFile)); !strings.Contains(s, "watched_directory") || !strings.Contains(s, MountPath+"/key.pem") {
		t.Errorf("sds.yaml:\n%s", s)
	}
	// The files link through ..data, so one rename switches them all.
	for _, name := range []string{FullchainFile, KeyFile, CAFile} {
		if target, err := os.Readlink(filepath.Join(out, name)); err != nil || target != filepath.Join("..data", name) {
			t.Errorf("%s -> %q, %v", name, target, err)
		}
	}
	data1, _ := os.Readlink(filepath.Join(out, "..data"))

	// Unchanged: nothing is rewritten.
	if err := m.Export(); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.Readlink(filepath.Join(out, "..data")); data != data1 {
		t.Error("rewrote an unchanged certificate")
	}

	// A new certificate: a new folder, and the old one goes.
	cert2, key2 := c.issue(t, "sm.test", "db.test")
	writeFile(t, cfg.TLS.CertFile, cert2)
	writeFile(t, cfg.TLS.KeyFile, key2)
	m.reloadFiles()
	data2, _ := os.Readlink(filepath.Join(out, "..data"))
	if data2 == data1 {
		t.Fatal("..data not swapped")
	}
	if _, err := os.Stat(filepath.Join(out, data1)); !os.IsNotExist(err) {
		t.Errorf("old folder %s kept: %v", data1, err)
	}
	pair, _ = tls.X509KeyPair(read(FullchainFile), read(KeyFile))
	if len(pair.Certificate) == 0 || string(pair.Certificate[0]) != string(m.Certificate("db.test").Certificate[0]) {
		t.Error("new certificate not exported")
	}
}

func TestExportOnlyWithProvisioning(t *testing.T) {
	dir := t.TempDir()
	c := newCA(t, "Test CA")
	cert, key := c.issue(t, "sm.test")
	cfg := filesConfig(t, dir, cert, key, c.pem)
	cfg.Provisioning.Enabled = false
	m, err := New(cfg, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Export(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cfg.Provisioning.StacksDir, ExportDirName)); !os.IsNotExist(err) {
		t.Errorf("exported without provisioning: %v", err)
	}
}

func TestACMEReadsStorage(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Default()
	cfg.Server.PublicURL = "https://sm.example.com"
	cfg.Server.HTTPSListen = ":8443"
	cfg.TLS.Mode = config.TLSACME
	cfg.TLS.ACME.AgreeTOS = true
	cfg.TLS.ACME.StorageDir = filepath.Join(dir, "acme")
	m, err := New(&cfg, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if m.Ready("sm.example.com") || len(m.Status().Missing) != 1 {
		t.Fatal("ready before obtaining")
	}
	if m.issuer.ListenHost != "" || m.issuer.AltHTTPPort != 8080 || m.issuer.AltTLSALPNPort != 8443 {
		t.Errorf("challenge ports %q %d %d", m.issuer.ListenHost, m.issuer.AltHTTPPort, m.issuer.AltTLSALPNPort)
	}
	if !slices.Contains(m.ServerTLSConfig().NextProtos, "acme-tls/1") {
		t.Error("tls-alpn-01 not offered")
	}

	// What certmagic stores once it has obtained a certificate.
	cert, key := newCA(t, "Fake LE").issue(t, "sm.example.com")
	store := func(k string, b []byte) {
		if err := m.magic.Storage.Store(t.Context(), k, b); err != nil {
			t.Fatal(err)
		}
	}
	store(certmagic.StorageKeys.SiteCert(m.issuer.IssuerKey(), "sm.example.com"), cert)
	store(certmagic.StorageKeys.SitePrivateKey(m.issuer.IssuerKey(), "sm.example.com"), key)
	m.fail(errors.New("earlier failure"))
	if !m.loadACME(t.Context()) || !m.Ready("sm.example.com") {
		t.Fatal("stored certificate not loaded")
	}
	if s := m.Status(); s.LastError != "" || len(s.Certs) != 1 || s.Certs[0].Issuer != "Test (Fake LE)" {
		t.Errorf("status %+v", s)
	}
	if m.loadACME(t.Context()) {
		t.Error("unchanged certificate reported as changed")
	}
}

// Exports at the same moment (start-up, and a stack starting) leave one
// complete set of files.
func TestExportConcurrently(t *testing.T) {
	dir := t.TempDir()
	c := newCA(t, "Test CA")
	cert, key := c.issue(t, "sm.test", "db.test")
	cfg := filesConfig(t, dir, cert, key, c.pem)
	m, err := New(cfg, quiet)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.mu.Lock()
			m.exported = [32]byte{} // as if nothing had been written yet
			m.mu.Unlock()
			if err := m.Export(); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	out := filepath.Join(cfg.Provisioning.StacksDir, ExportDirName)
	if _, err := tls.LoadX509KeyPair(filepath.Join(out, FullchainFile), filepath.Join(out, KeyFile)); err != nil {
		t.Fatalf("after concurrent exports: %v", err)
	}
	// stacks_dir, made here, keeps other users out of the key.
	st, err := os.Stat(cfg.Provisioning.StacksDir)
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("stacks_dir mode %v, %v", st.Mode().Perm(), err)
	}
}

// An ACME folder Supermixer can't write stops start-up, not the first
// certificate.
func TestACMEStorageNotWritable(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root can write anywhere")
	}
	dir := filepath.Join(t.TempDir(), "acme")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Server.PublicURL = "https://sm.example.com"
	cfg.TLS.Mode = config.TLSACME
	cfg.TLS.ACME.AgreeTOS = true
	cfg.TLS.ACME.StorageDir = dir
	if _, err := New(&cfg, quiet); err == nil || !strings.Contains(err.Error(), "isn't writable by user") {
		t.Errorf("New = %v", err)
	}
}
