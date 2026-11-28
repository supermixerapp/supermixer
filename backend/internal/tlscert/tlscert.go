// Package tlscert is where Supermixer's certificate comes from ([tls] in the
// config): the operator's own files, read again when they change, or an ACME
// CA such as Let's Encrypt, obtained and renewed automatically. One Manager
// serves Supermixer's own HTTPS and hands the certificate to the stacks it
// creates, by writing it to a folder they mount (see Export).
package tlscert

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/certmagic"
	"github.com/mholt/acmez/v3"
	"go.uber.org/zap"

	"supermixer/internal/config"
)

// filesInterval is how often files mode looks for changed files.
const filesInterval = 30 * time.Second

// acmeInterval is how often acme mode rereads its storage, besides when
// certmagic says it obtained a certificate.
const acmeInterval = 10 * time.Minute

// Manager holds the current certificate. A nil *Manager is TLS off: its
// methods report nothing ready and serve nothing.
type Manager struct {
	mode       string
	names      []string // what the certificate must cover
	exportName string   // the name whose certificate goes to the stacks
	exportDir  string   // where it goes; "" exports nothing
	log        *slog.Logger
	roots      *x509.CertPool // what a certificate must chain to; nil is the system's
	caPEM      []byte         // the private CA, for download and the stacks

	// files mode
	certFile, keyFile string

	// acme mode
	magic      *certmagic.Config
	issuer     *certmagic.ACMEIssuer
	challenges []string

	reload chan struct{}
	// exportMu runs one Export at a time: each cleans up the folders of
	// earlier ones.
	exportMu sync.Mutex
	// filesRetry is how long reloadFiles waits before trying a pair that
	// didn't load again: writers replace the certificate and key one after
	// the other.
	filesRetry time.Duration

	mu        sync.RWMutex
	certs     map[string]*tls.Certificate // by name
	sum       [32]byte                    // files mode: the files last loaded
	failedSum [32]byte                    // files mode: files that didn't load, not tried again until they change
	exported  [32]byte                    // the certificate last exported
	lastErr   string
	lastErrAt time.Time
	onChange  []func()
}

// Status describes the certificate, for Instance › Overview.
type Status struct {
	Mode      string
	Names     []string
	PrivateCA bool
	Certs     []CertStatus
	// Missing are names without a certificate yet (acme mode, obtaining).
	Missing     []string
	LastError   string
	LastErrorAt time.Time
}

// CertStatus is one certificate.
type CertStatus struct {
	Names    []string
	Issuer   string
	NotAfter time.Time
}

// New makes the manager for cfg, or nil with TLS off. In files mode it
// loads the files now, so a mistake stops start-up; acme mode starts
// obtaining certificates in Start.
func New(cfg *config.Config, log *slog.Logger) (*Manager, error) {
	t := cfg.TLS
	if !t.Enabled() {
		return nil, nil
	}
	m := &Manager{
		mode:   t.Mode,
		names:  cfg.TLSNames(),
		log:    log.With("component", "tls"),
		reload: make(chan struct{}, 1),
		certs:  map[string]*tls.Certificate{},
		// Not long: a writer swapping two files is done within a moment.
		filesRetry: 2 * time.Second,
	}
	if pv := cfg.Provisioning; pv.Enabled {
		m.exportName = strings.ToLower(strings.Trim(pv.PublicHost, "[]"))
		m.exportDir = filepath.Join(pv.StacksDir, ExportDirName)
	}
	switch t.Mode {
	case config.TLSFiles:
		m.certFile, m.keyFile = t.CertFile, t.KeyFile
		if t.CAFile != "" {
			b, err := os.ReadFile(t.CAFile)
			if err != nil {
				return nil, fmt.Errorf("tls.ca_file: %w", err)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(b) {
				return nil, fmt.Errorf("tls.ca_file %s has no PEM certificates", t.CAFile)
			}
			m.roots, m.caPEM = pool, b
		}
		cert, sum, err := m.loadFiles()
		if err != nil {
			return nil, err
		}
		m.setFiles(cert, sum)
	case config.TLSACME:
		m.challenges = cfg.ACMEChallenges()
		if err := m.setupACME(cfg); err != nil {
			return nil, err
		}
	}
	return m, nil
}

// Enabled reports whether there's a certificate source.
func (m *Manager) Enabled() bool { return m != nil }

// Names are the host names the certificate covers.
func (m *Manager) Names() []string {
	if m == nil {
		return nil
	}
	return slices.Clone(m.names)
}

// PrivateCA reports whether the certificate is from the operator's own CA.
func (m *Manager) PrivateCA() bool { return m != nil && m.caPEM != nil }

// CAPEM is the private CA's certificate, or nil for a public CA.
func (m *Manager) CAPEM() []byte {
	if m == nil {
		return nil
	}
	return m.caPEM
}

// OnChange calls fn after each new certificate (after it's exported).
func (m *Manager) OnChange(fn func()) {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.onChange = append(m.onChange, fn)
	m.mu.Unlock()
}

// Start runs until ctx ends: files mode watches the files, acme mode
// obtains and renews certificates. Call it once Supermixer's listeners are
// bound, so ACME challenges find them.
func (m *Manager) Start(ctx context.Context) error {
	if m == nil {
		return nil
	}
	if err := m.Export(); err != nil {
		m.log.Error("writing the certificate for the stacks", "dir", m.exportDir, "err", err)
	}
	switch m.mode {
	case config.TLSFiles:
		go m.watchFiles(ctx)
	case config.TLSACME:
		if err := m.magic.ManageAsync(ctx, m.names); err != nil {
			return fmt.Errorf("tls: %w", err)
		}
		go m.watchACME(ctx)
	}
	return nil
}

// Reload rereads the files now (SIGHUP) rather than at the next check.
func (m *Manager) Reload() {
	if m == nil {
		return
	}
	select {
	case m.reload <- struct{}{}:
	default:
	}
}

// Ready reports whether there's a certificate for name.
func (m *Manager) Ready(name string) bool {
	if m == nil {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.certs[strings.ToLower(name)] != nil
}

// Certificate is the current certificate for name, or nil.
func (m *Manager) Certificate(name string) *tls.Certificate {
	if m == nil {
		return nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.certs[strings.ToLower(name)]
}

// ServerTLSConfig serves the certificate, TLS 1.2 or later.
func (m *Manager) ServerTLSConfig() *tls.Config {
	if m == nil {
		return nil
	}
	if m.mode == config.TLSACME {
		c := m.magic.TLSConfig()
		c.MinVersion = tls.VersionTLS12
		// h2 first; acme-tls/1 is only ever offered alone, by the CA.
		c.NextProtos = []string{"h2", "http/1.1", acmez.ACMETLS1Protocol}
		return c
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"h2", "http/1.1"},
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			// One certificate covers every name.
			if c := m.Certificate(m.names[0]); c != nil {
				return c, nil
			}
			return nil, errors.New("no certificate")
		},
	}
}

// HTTPChallenge answers ACME http-01 challenges ahead of next.
func (m *Manager) HTTPChallenge(next http.Handler) http.Handler {
	if m == nil || m.issuer == nil || !slices.Contains(m.challenges, "http-01") {
		return next
	}
	return m.issuer.HTTPChallengeHandler(next)
}

// RootCAs are the CAs to trust when Supermixer connects to its own stacks:
// the system's, and the private CA.
func (m *Manager) RootCAs() *x509.CertPool {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if m != nil && m.caPEM != nil {
		pool.AppendCertsFromPEM(m.caPEM)
	}
	return pool
}

// Issued reports whether leaf (DER) is a certificate this manager holds, so
// Supermixer can trust its own stacks even with a CA nothing else trusts,
// such as Let's Encrypt's staging CA.
func (m *Manager) Issued(leaf []byte) bool {
	if m == nil {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, c := range m.certs {
		if len(c.Certificate) > 0 && string(c.Certificate[0]) == string(leaf) {
			return true
		}
	}
	return false
}

// Status describes the certificates and the last error.
func (m *Manager) Status() Status {
	if m == nil {
		return Status{Mode: config.TLSOff}
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := Status{Mode: m.mode, Names: slices.Clone(m.names), PrivateCA: m.caPEM != nil, LastError: m.lastErr, LastErrorAt: m.lastErrAt}
	seen := map[*tls.Certificate]bool{}
	for _, n := range m.names {
		c := m.certs[n]
		if c == nil {
			s.Missing = append(s.Missing, n)
			continue
		}
		if seen[c] || c.Leaf == nil {
			continue
		}
		seen[c] = true
		s.Certs = append(s.Certs, CertStatus{Names: certNames(c.Leaf), Issuer: issuerName(c.Leaf), NotAfter: c.Leaf.NotAfter})
	}
	return s
}

// Expiry is when each name's certificate expires, for metrics.
func (m *Manager) Expiry() map[string]time.Time {
	out := map[string]time.Time{}
	if m == nil {
		return out
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for n, c := range m.certs {
		if c.Leaf != nil {
			out[n] = c.Leaf.NotAfter
		}
	}
	return out
}

func (m *Manager) fail(err error) {
	m.mu.Lock()
	m.lastErr, m.lastErrAt = err.Error(), time.Now()
	m.mu.Unlock()
}

func (m *Manager) changed() {
	if err := m.Export(); err != nil {
		m.log.Error("writing the certificate for the stacks", "dir", m.exportDir, "err", err)
		m.fail(fmt.Errorf("writing the certificate for the stacks: %w", err))
	}
	m.mu.RLock()
	fns := slices.Clone(m.onChange)
	m.mu.RUnlock()
	for _, fn := range fns {
		fn()
	}
}

// ---- files mode ----

// loadFiles reads and checks the certificate and key.
func (m *Manager) loadFiles() (*tls.Certificate, [32]byte, error) {
	var sum [32]byte
	certPEM, err := os.ReadFile(m.certFile)
	if err != nil {
		return nil, sum, fmt.Errorf("tls.cert_file: %w", err)
	}
	keyPEM, err := os.ReadFile(m.keyFile)
	if err != nil {
		return nil, sum, fmt.Errorf("tls.key_file: %w", err)
	}
	sum = sha256.Sum256(append(append(certPEM, 0), keyPEM...))
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, sum, fmt.Errorf("tls.cert_file and tls.key_file: %w", err)
	}
	if err := m.check(cert); err != nil {
		return nil, sum, err
	}
	return &cert, sum, nil
}

// check makes sure the certificate covers every name and chains to a CA
// the configuration trusts.
func (m *Manager) check(cert tls.Certificate) error {
	leaf := cert.Leaf
	if leaf == nil {
		var err error
		if leaf, err = x509.ParseCertificate(cert.Certificate[0]); err != nil {
			return fmt.Errorf("tls.cert_file: %w", err)
		}
	}
	for _, n := range m.names {
		if err := leaf.VerifyHostname(n); err != nil {
			return fmt.Errorf("tls.cert_file doesn't cover %s (it covers %s)", n, strings.Join(certNames(leaf), ", "))
		}
	}
	inter := x509.NewCertPool()
	for _, der := range cert.Certificate[1:] {
		if c, err := x509.ParseCertificate(der); err == nil {
			inter.AddCert(c)
		}
	}
	_, err := leaf.Verify(x509.VerifyOptions{Roots: m.roots, Intermediates: inter, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	switch {
	case err == nil:
		return nil
	case m.roots == nil:
		return fmt.Errorf("tls.cert_file isn't from a CA this system trusts (%v); for a private CA or a self-signed certificate, set tls.ca_file", err)
	default:
		return fmt.Errorf("tls.cert_file doesn't check out against tls.ca_file: %v", err)
	}
}

// seen reports whether the files with sum were loaded already, or failed.
func (m *Manager) seen(sum [32]byte) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return sum == m.sum || sum == m.failedSum
}

func (m *Manager) setFiles(cert *tls.Certificate, sum [32]byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sum, m.failedSum = sum, [32]byte{}
	for _, n := range m.names {
		m.certs[n] = cert
	}
	if m.exportName != "" {
		m.certs[m.exportName] = cert
	}
	m.lastErr, m.lastErrAt = "", time.Time{}
}

func (m *Manager) watchFiles(ctx context.Context) {
	t := time.NewTicker(filesInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-m.reload:
		}
		m.reloadFiles()
	}
}

// reloadFiles loads the files if they changed. A bad pair keeps the
// certificate in use and records why, once: the same files aren't tried
// again until they change.
func (m *Manager) reloadFiles() {
	cert, sum, err := m.loadFiles()
	if err != nil && !m.seen(sum) {
		// Perhaps caught between the certificate and the key being
		// replaced: a moment later they match.
		time.Sleep(m.filesRetry)
		cert, sum, err = m.loadFiles()
	}
	if m.seen(sum) {
		return
	}
	if err != nil {
		m.log.Error("keeping the current certificate: the new files don't work", "err", err)
		m.fail(err)
		m.mu.Lock()
		m.failedSum = sum
		m.mu.Unlock()
		return
	}
	m.setFiles(cert, sum)
	m.log.Info("loaded a new certificate", "names", certNames(cert.Leaf), "expires", cert.Leaf.NotAfter)
	m.changed()
}

// ---- acme mode ----

func (m *Manager) setupACME(cfg *config.Config) error {
	a := cfg.TLS.ACME
	if err := os.MkdirAll(a.StorageDir, 0o700); err != nil {
		return fmt.Errorf("tls.acme.storage_dir: %w", err)
	}
	// Found out now, not when a certificate arrives and can't be kept.
	probe, err := os.CreateTemp(a.StorageDir, ".write-check-*")
	if err != nil {
		return fmt.Errorf("tls.acme.storage_dir %s isn't writable by user %d: %w", a.StorageDir, os.Getuid(), err)
	}
	probe.Close()
	_ = os.Remove(probe.Name())
	zl := zap.New(slogCore{l: m.log})
	var magic *certmagic.Config
	cache := certmagic.NewCache(certmagic.CacheOptions{
		GetConfigForCert: func(certmagic.Certificate) (*certmagic.Config, error) { return magic, nil },
		Logger:           zl,
	})
	magic = certmagic.New(cache, certmagic.Config{
		Storage:           &certmagic.FileStorage{Path: a.StorageDir},
		Logger:            zl,
		DefaultServerName: m.names[0],
		OnEvent:           m.onEvent,
	})
	issuer := certmagic.NewACMEIssuer(magic, certmagic.ACMEIssuer{
		CA:                      a.CAURL,
		Email:                   a.Email,
		Agreed:                  a.AgreeTOS,
		DisableHTTPChallenge:    !slices.Contains(m.challenges, "http-01"),
		DisableTLSALPNChallenge: !slices.Contains(m.challenges, "tls-alpn-01"),
		Logger:                  zl,
	})
	// certmagic opens its own listener for a challenge unless the port's
	// taken; point it at Supermixer's, which answer them.
	issuer.ListenHost, issuer.AltHTTPPort = hostPort(cfg.Server.Listen)
	if cfg.Server.HTTPSListen != "" {
		_, issuer.AltTLSALPNPort = hostPort(cfg.Server.HTTPSListen)
	}
	magic.Issuers = []certmagic.Issuer{issuer}
	m.magic, m.issuer = magic, issuer
	m.loadACME(context.Background())
	return nil
}

// onEvent hears from certmagic; it must return quickly.
func (m *Manager) onEvent(_ context.Context, event string, data map[string]any) error {
	switch event {
	case "cert_obtained", "cached_managed_cert":
		m.Reload()
	case "cert_failed":
		err, _ := data["error"].(error)
		if err == nil {
			err = errors.New("unknown error")
		}
		m.fail(fmt.Errorf("obtaining a certificate for %v: %w", data["identifier"], err))
	}
	return nil
}

func (m *Manager) watchACME(ctx context.Context) {
	t := time.NewTicker(acmeInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-m.reload:
		}
		if m.loadACME(ctx) {
			m.changed()
		}
	}
}

// loadACME reads each name's certificate from certmagic's storage, and
// reports whether any changed.
func (m *Manager) loadACME(ctx context.Context) bool {
	changed := false
	for _, n := range m.names {
		certPEM, err1 := m.magic.Storage.Load(ctx, certmagic.StorageKeys.SiteCert(m.issuer.IssuerKey(), n))
		keyPEM, err2 := m.magic.Storage.Load(ctx, certmagic.StorageKeys.SitePrivateKey(m.issuer.IssuerKey(), n))
		if err1 != nil || err2 != nil {
			continue // not obtained yet
		}
		cert, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil {
			m.log.Error("reading a stored certificate", "name", n, "err", err)
			continue
		}
		m.mu.Lock()
		if old := m.certs[n]; old == nil || string(old.Certificate[0]) != string(cert.Certificate[0]) {
			m.certs[n] = &cert
			changed = true
			if m.lastErr != "" && len(m.missingLocked()) == 0 {
				m.lastErr, m.lastErrAt = "", time.Time{}
			}
			m.log.Info("certificate ready", "name", n, "issuer", issuerName(cert.Leaf), "expires", cert.Leaf.NotAfter)
		}
		m.mu.Unlock()
	}
	return changed
}

func (m *Manager) missingLocked() []string {
	var out []string
	for _, n := range m.names {
		if m.certs[n] == nil {
			out = append(out, n)
		}
	}
	return out
}

// ---- helpers ----

func certNames(c *x509.Certificate) []string {
	names := slices.Clone(c.DNSNames)
	for _, ip := range c.IPAddresses {
		names = append(names, ip.String())
	}
	if len(names) == 0 && c.Subject.CommonName != "" {
		names = append(names, c.Subject.CommonName)
	}
	return names
}

func issuerName(c *x509.Certificate) string {
	if c == nil {
		return ""
	}
	if len(c.Issuer.Organization) > 0 {
		if c.Issuer.CommonName != "" {
			return c.Issuer.Organization[0] + " (" + c.Issuer.CommonName + ")"
		}
		return c.Issuer.Organization[0]
	}
	return c.Issuer.CommonName
}
