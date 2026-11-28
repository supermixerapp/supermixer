package tlscert

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ExportDirName is the folder in provisioning.stacks_dir that holds the
// certificate for the stacks. Each stack mounts it (the whole folder, never
// single files, so a renewed certificate is seen) at MountPath.
const ExportDirName = ".tls"

// MountPath is where stacks' containers see the exported folder.
const MountPath = "/etc/supermixer/tls"

// Files in the exported folder.
const (
	FullchainFile = "fullchain.pem"
	KeyFile       = "key.pem"
	CAFile        = "ca.pem"
	// SDSFile tells Envoy where the certificate is, and to watch the
	// folder for a new one.
	SDSFile = "sds.yaml"
	// SDSSecret is the secret's name in SDSFile.
	SDSSecret = "supermixer_certificate"
)

// sds is Envoy's secret discovery file. watched_directory reloads the
// certificate when ..data is swapped (a move into the folder).
var sds = `resources:
  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
    name: ` + SDSSecret + `
    tls_certificate:
      certificate_chain:
        filename: ` + MountPath + `/` + FullchainFile + `
      private_key:
        filename: ` + MountPath + `/` + KeyFile + `
      watched_directory:
        path: ` + MountPath + `
`

// Export writes the stacks' certificate, if it has changed, the way
// Kubernetes updates mounted secrets: the files go in a new ..<time>
// folder, the ..data link swaps to it in one rename, and fullchain.pem and
// key.pem link through ..data, so a reader never sees half of a change.
func (m *Manager) Export() error {
	if m == nil || m.exportDir == "" {
		return nil
	}
	m.exportMu.Lock()
	defer m.exportMu.Unlock()
	cert := m.Certificate(m.exportName)
	if cert == nil {
		return nil // not obtained yet
	}
	var chain bytes.Buffer
	for _, der := range cert.Certificate {
		_ = pem.Encode(&chain, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		return fmt.Errorf("encoding the key: %w", err)
	}
	key := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	sum := sha256.Sum256(append(append(chain.Bytes(), key...), m.caPEM...))

	dir := m.exportDir
	m.mu.RLock()
	same := sum == m.exported
	m.mu.RUnlock()
	if same && fileExists(filepath.Join(dir, "..data", FullchainFile)) {
		return nil
	}
	// The key is readable by all inside the folder (the stacks' containers
	// run as various users), so stacks_dir itself must keep everyone else
	// out. Created here first, it's created private.
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return err
	}
	if st, err := os.Stat(filepath.Dir(dir)); err == nil && st.Mode().Perm()&0o077 != 0 {
		m.log.Warn("other users of this machine can read the stacks' private key: chmod 700 provisioning.stacks_dir",
			"dir", filepath.Dir(dir), "mode", st.Mode().Perm().String())
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	ts := "..ts_" + time.Now().UTC().Format("20060102T150405.000000000")
	tsDir := filepath.Join(dir, ts)
	if err := os.Mkdir(tsDir, 0o755); err != nil {
		return err
	}
	files := map[string][]byte{FullchainFile: chain.Bytes(), KeyFile: key}
	if m.caPEM != nil {
		files[CAFile] = m.caPEM
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(tsDir, name), b, 0o644); err != nil {
			return err
		}
	}
	tmp := filepath.Join(dir, "..data_tmp")
	_ = os.Remove(tmp)
	if err := os.Symlink(ts, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "..data")); err != nil {
		return err
	}
	names := []string{FullchainFile, KeyFile, CAFile}
	for _, name := range names {
		link := filepath.Join(dir, name)
		if _, ok := files[name]; !ok {
			_ = os.Remove(link)
			continue
		}
		if target, err := os.Readlink(link); err == nil && target == filepath.Join("..data", name) {
			continue
		}
		_ = os.Remove(link)
		if err := os.Symlink(filepath.Join("..data", name), link); err != nil {
			return err
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, SDSFile)); err != nil || string(b) != sds {
		if err := writeAtomic(filepath.Join(dir, SDSFile), []byte(sds)); err != nil {
			return err
		}
	}
	// Earlier versions go once nothing links to them.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "..ts_") && e.Name() != ts {
			_ = os.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
	m.mu.Lock()
	m.exported = sum
	m.mu.Unlock()
	m.log.Info("certificate written for the stacks", "dir", dir)
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func writeAtomic(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
