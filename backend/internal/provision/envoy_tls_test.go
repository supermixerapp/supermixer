package provision

import (
	"encoding/json"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"supermixer/internal/tlscert"
)

func bundled(t *testing.T, name string) string {
	t.Helper()
	b, err := fs.ReadFile(templateFS, "template/"+name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestTLSListener(t *testing.T) {
	lds := bundled(t, ldsFile)
	out, err := tlsListener(lds)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out, strings.TrimRight(lds, "\n")) {
		t.Error("the plain listener changed")
	}
	tls := out[len(strings.TrimRight(lds, "\n")):]
	for _, want := range []string{
		"name: supabase_tls", "port_value: 8443", "envoy.filters.listener.tls_inspector", "transport_protocol: tls",
		"name: " + tlscert.SDSSecret, "path: /etc/supermixer/tls/sds.yaml", "default_filter_chain:", "https_redirect: true",
		"response_code: PERMANENT_REDIRECT", "tls_minimum_protocol_version: TLSv1_2",
	} {
		if !strings.Contains(tls, want) {
			t.Errorf("TLS listener lacks %q", want)
		}
	}
	// The routes, keys and filters are the plain listener's.
	for _, same := range []string{"${ANON_KEY}", "upgrade_type: websocket", "use_remote_address: true", "/realtime/v1/"} {
		if strings.Count(out, same) != 2*strings.Count(lds, same) {
			t.Errorf("%q isn't in both listeners", same)
		}
	}

	// A template that's changed shape is an error, not a guess.
	for name, changed := range map[string]string{
		"two listeners":    lds + "\n" + lds[strings.Index(lds, listenerStart):],
		"another port":     strings.Replace(lds, listenerPort, "        port_value: 9000\n", 1),
		"listener filters": strings.Replace(lds, filterChains, "    listener_filters: []\n"+filterChains, 1),
		"no listener":      "resources: []\n",
	} {
		if _, err := tlsListener(changed); err == nil || !strings.Contains(err.Error(), "update tlsListener") {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestPoolerWithTLS(t *testing.T) {
	out, err := poolerWithTLS(bundled(t, poolerScript))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Supavisor.Tenants.update_tenant(tenant, %{\"enforce_ssl\" => enforce_ssl})") ||
		strings.Index(out, "create_tenant") > strings.Index(out, "update_tenant") {
		t.Errorf("pooler script:\n%s", out)
	}
	if _, err := poolerWithTLS("IO.puts(:hello)"); err == nil {
		t.Error("an unrecognised script was accepted")
	}
}

// What Compose makes of a stack's files with and without TLS (needs the
// docker CLI).
func TestTLSOverlay(t *testing.T) {
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("no docker CLI")
	}
	dir := writtenStack(t)
	type service struct {
		Ports []struct {
			Target    int    `json:"target"`
			Published string `json:"published"`
		} `json:"ports"`
		Volumes []struct {
			Source string `json:"source"`
			Target string `json:"target"`
		} `json:"volumes"`
		Environment map[string]*string         `json:"environment"`
		DependsOn   map[string]json.RawMessage `json:"depends_on"`
	}
	for _, tc := range []struct{ tls, studio bool }{{true, false}, {true, true}, {false, false}, {false, true}} {
		if err := UpdateEnv(dir, map[string]string{TLSEnv: boolStr(tc.tls), StudioEnv: boolStr(tc.studio), "API_GW_HTTP_PORT": "8201"}); err != nil {
			t.Fatal(err)
		}
		if err := RefreshOverlay(dir); err != nil {
			t.Fatal(err)
		}
		_, err := os.Stat(filepath.Join(dir, filepath.FromSlash(ldsTLSFile)))
		if tc.tls && err != nil {
			t.Errorf("%+v: no TLS listener file: %v", tc, err)
		}
		cmd := exec.Command("docker", "compose", "config", "--format", "json")
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				t.Fatalf("%+v: docker compose config: %s", tc, ee.Stderr)
			}
			t.Skipf("docker compose config: %v", err)
		}
		var cfg struct{ Services map[string]service }
		if err := json.Unmarshal(out, &cfg); err != nil {
			t.Fatal(err)
		}
		gw, sv := cfg.Services["api-gw"], cfg.Services["supavisor"]

		wantTarget := 8000
		if tc.tls {
			wantTarget = EnvoyTLSPort
		}
		if len(gw.Ports) != 1 || gw.Ports[0].Target != wantTarget || gw.Ports[0].Published != "8201" {
			t.Errorf("%+v: api-gw ports %+v", tc, gw.Ports)
		}
		mounts := map[string]string{}
		for _, v := range gw.Volumes {
			mounts[v.Target] = v.Source
		}
		if lds := mounts["/etc/envoy/lds.template.yaml"]; strings.HasSuffix(lds, "lds.tls.template.yaml") != tc.tls {
			t.Errorf("%+v: Envoy's listener template is %s", tc, lds)
		}
		if src, ok := mounts[tlscert.MountPath]; ok != tc.tls || (ok && src != filepath.Join(filepath.Dir(dir), tlscert.ExportDirName)) {
			t.Errorf("%+v: certificate folder %q", tc, src)
		}
		if _, ok := gw.DependsOn["studio"]; ok != tc.studio {
			t.Errorf("%+v: api-gw depends on %v", tc, gw.DependsOn)
		}

		if deref(sv.Environment["SUPERMIXER_POOLER_ENFORCE_SSL"]) != boolStr(tc.tls) {
			t.Errorf("%+v: enforce_ssl %q", tc, deref(sv.Environment["SUPERMIXER_POOLER_ENFORCE_SSL"]))
		}
		if cert := deref(sv.Environment["GLOBAL_DOWNSTREAM_CERT_PATH"]); (cert == tlscert.MountPath+"/fullchain.pem") != tc.tls {
			t.Errorf("%+v: pooler certificate %q", tc, cert)
		}
		poolerMounts := map[string]string{}
		for _, v := range sv.Volumes {
			poolerMounts[v.Target] = v.Source
		}
		if !strings.HasSuffix(poolerMounts["/etc/pooler/pooler.exs"], poolerScriptFile) {
			t.Errorf("%+v: pooler script %q", tc, poolerMounts["/etc/pooler/pooler.exs"])
		}
	}
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
