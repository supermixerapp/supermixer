package stack

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// testCert is a CA and a certificate from it for names.
func testCert(t *testing.T, names ...string) (*x509.CertPool, tls.Certificate) {
	t.Helper()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	ca, _ := x509.ParseCertificate(caDER)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: names[0]}, DNSNames: names,
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	return pool, tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func TestNetworkHTTPS(t *testing.T) {
	roots, cert := testCert(t, "stack.test")
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.Host))
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	url := "https://stack.test:" + port + "/"

	for _, tc := range []struct {
		name   string
		n      *Network
		wantOK bool
	}{
		// stack.test is only reachable through its alias, and the
		// certificate is checked for stack.test.
		{"trusted CA", NewNetwork(map[string]string{"stack.test": "127.0.0.1"}, roots, nil), true},
		{"untrusted CA", NewNetwork(map[string]string{"stack.test": "127.0.0.1"}, x509.NewCertPool(), nil), false},
		{"Supermixer's own certificate", NewNetwork(map[string]string{"STACK.test": "127.0.0.1"}, x509.NewCertPool(),
			func(der []byte) bool { return string(der) == string(cert.Certificate[0]) }), true},
		{"someone else's certificate", NewNetwork(map[string]string{"stack.test": "127.0.0.1"}, x509.NewCertPool(),
			func([]byte) bool { return false }), false},
	} {
		c := &http.Client{Transport: tc.n.Transport(), Timeout: 5 * time.Second}
		resp, err := c.Get(url)
		if (err == nil) != tc.wantOK {
			t.Errorf("%s: %v", tc.name, err)
			continue
		}
		if err == nil {
			resp.Body.Close()
		}
	}

	// The certificate must still be for the name asked for.
	n := NewNetwork(map[string]string{"other.test": "127.0.0.1"}, x509.NewCertPool(),
		func(der []byte) bool { return string(der) == string(cert.Certificate[0]) })
	c := &http.Client{Transport: n.Transport(), Timeout: 5 * time.Second}
	if _, err := c.Get("https://other.test:" + port + "/"); err == nil || !strings.Contains(err.Error(), "other.test") {
		t.Errorf("wrong name accepted: %v", err)
	}
}

func TestNetworkPostgres(t *testing.T) {
	n := NewNetwork(map[string]string{"db.stack.test": "127.0.0.1"}, nil, func([]byte) bool { return false })
	cfg, err := pgconn.ParseConfig("postgres://u@db.stack.test:5432/postgres?sslmode=verify-full")
	if err != nil {
		t.Fatal(err)
	}
	n.ConfigurePg(cfg)
	addrs, err := cfg.LookupFunc(context.Background(), "db.stack.test")
	if err != nil || len(addrs) != 1 || addrs[0] != "127.0.0.1" {
		t.Errorf("lookup = %v, %v", addrs, err)
	}
	if cfg.TLSConfig == nil || cfg.TLSConfig.ServerName != "db.stack.test" || cfg.TLSConfig.VerifyConnection == nil {
		t.Errorf("verify-full not checked by the network: %+v", cfg.TLSConfig)
	}
	// Without TLS, nothing to change.
	cfg, _ = pgconn.ParseConfig("postgres://u@db.stack.test:5432/postgres?sslmode=disable")
	n.ConfigurePg(cfg)
	if cfg.TLSConfig != nil {
		t.Error("TLS added to sslmode=disable")
	}
}
