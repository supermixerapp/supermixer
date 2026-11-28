package stack

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Network is how Supermixer reaches projects' stacks. Projects keep the
// addresses their users use; Network dials some of those host names
// elsewhere (a stack Supermixer created is at public_host for users, but
// Supermixer itself may reach it at connect_host, host.docker.internal
// from a container), while TLS still checks the name users see. It also
// knows which CAs to trust. A nil *Network dials as given and trusts the
// system's CAs.
type Network struct {
	aliases map[string]string // host name → host to dial instead
	roots   *x509.CertPool    // nil: the system's
	// issued reports whether a certificate (DER) is Supermixer's own, so
	// its stacks are trusted even with a CA nothing else trusts.
	issued func(der []byte) bool
	dialer *net.Dialer
}

// NewNetwork makes a Network. aliases maps host names to the hosts to
// dial instead; roots, if set, replaces the system's CAs.
func NewNetwork(aliases map[string]string, roots *x509.CertPool, issued func(der []byte) bool) *Network {
	a := map[string]string{}
	for from, to := range aliases {
		from, to = strings.ToLower(strings.Trim(from, "[]")), strings.Trim(to, "[]")
		if from != "" && to != "" && !strings.EqualFold(from, to) {
			a[from] = to
		}
	}
	return &Network{aliases: a, roots: roots, issued: issued, dialer: &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}}
}

// alias is the host to dial for host.
func (n *Network) alias(host string) (string, bool) {
	if n == nil {
		return host, false
	}
	to, ok := n.aliases[strings.ToLower(strings.Trim(host, "[]"))]
	if !ok {
		return host, false
	}
	return to, true
}

// dialAddr rewrites host:port.
func (n *Network) dialAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if to, ok := n.alias(host); ok {
		return net.JoinHostPort(to, port)
	}
	return addr
}

// Dial connects to addr, through its alias if it has one.
func (n *Network) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	return n.dial(ctx, network, addr)
}

func (n *Network) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	if n != nil {
		d = n.dialer
	}
	return d.DialContext(ctx, network, n.dialAddr(addr))
}

// TLSConfig checks a stack's certificate for serverName (the name users
// see, never the alias).
func (n *Network) TLSConfig(serverName string) *tls.Config {
	var roots *x509.CertPool
	var issued func([]byte) bool
	if n != nil {
		roots, issued = n.roots, n.issued
	}
	if issued == nil {
		return &tls.Config{ServerName: serverName, RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return &tls.Config{
		ServerName: serverName,
		MinVersion: tls.VersionTLS12,
		// Checked in VerifyConnection instead: the usual checks, and failing
		// those, Supermixer's own certificate for this name.
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("tls: the server sent no certificate")
			}
			leaf := cs.PeerCertificates[0]
			inter := x509.NewCertPool()
			for _, c := range cs.PeerCertificates[1:] {
				inter.AddCert(c)
			}
			_, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter, DNSName: serverName})
			if err != nil && issued(leaf.Raw) && leaf.VerifyHostname(serverName) == nil && time.Now().Before(leaf.NotAfter) {
				return nil
			}
			return err
		},
	}
}

// Transport is an HTTP transport to stacks: aliased host names are
// dialled directly (never through a proxy, which wouldn't know them), and
// HTTPS checks certificates with TLSConfig.
func (n *Network) Transport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = n.dial
	t.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		raw, err := n.dial(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		c := tls.Client(raw, n.TLSConfig(strings.Trim(host, "[]")))
		if err := c.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		return c, nil
	}
	// Through a proxy, the proxy dials and TLS uses this.
	if n != nil {
		t.TLSClientConfig = &tls.Config{RootCAs: n.roots, MinVersion: tls.VersionTLS12}
	}
	t.Proxy = func(r *http.Request) (*url.URL, error) {
		if _, ok := n.alias(r.URL.Hostname()); ok {
			return nil, nil
		}
		return http.ProxyFromEnvironment(r)
	}
	return t
}

// ConfigurePg makes a parsed Postgres configuration use the Network:
// aliased host names resolve to their alias, and verify-full checks the
// certificate with TLSConfig (other sslmodes are left as libpq defines
// them).
func (n *Network) ConfigurePg(cfg *pgconn.Config) {
	if n == nil {
		return
	}
	lookup := cfg.LookupFunc
	cfg.LookupFunc = func(ctx context.Context, host string) ([]string, error) {
		if to, ok := n.alias(host); ok {
			host = to
		}
		if lookup != nil {
			return lookup(ctx, host)
		}
		return net.DefaultResolver.LookupHost(ctx, host)
	}
	verifyFull := func(tc *tls.Config) *tls.Config {
		// verify-full: pgx checks the chain and the name (ServerName).
		if tc == nil || tc.InsecureSkipVerify || tc.ServerName == "" {
			return tc
		}
		out := n.TLSConfig(tc.ServerName)
		out.Certificates = tc.Certificates
		return out
	}
	cfg.TLSConfig = verifyFull(cfg.TLSConfig)
	for _, fb := range cfg.Fallbacks {
		fb.TLSConfig = verifyFull(fb.TLSConfig)
	}
}
