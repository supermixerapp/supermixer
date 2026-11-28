package provision

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"supermixer/internal/tlscert"
)

// Envoy's listener template, and the TLS version Supermixer generates from
// it, in a stack's folder.
const (
	ldsFile    = "volumes/api/envoy/lds.template.yaml"
	ldsTLSFile = "volumes/api/envoy/lds.tls.template.yaml"
)

// EnvoyTLSPort is the gateway's TLS listener inside its container. The
// stack's API port is published there instead of on 8000, which stays
// plain HTTP for the stack's own services (Studio, Functions, Vector).
const EnvoyTLSPort = 8443

const (
	listenerStart = "  - '@type': type.googleapis.com/envoy.config.listener.v3.Listener\n"
	listenerName  = "    name: supabase\n"
	listenerPort  = "        port_value: 8000\n"
	filterChains  = "    filter_chains:\n      - filters:\n"
)

// tlsListenerChains turns the listener's one filter chain into the TLS
// chain: tls_inspector tells TLS from plain HTTP, and the certificate comes
// from the exported folder through SDS, which reloads it when ..data swaps.
var tlsListenerChains = `    listener_filters:
      - name: envoy.filters.listener.tls_inspector
        typed_config:
          '@type': type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
    filter_chains:
      - filter_chain_match:
          transport_protocol: tls
        transport_socket:
          name: envoy.transport_sockets.tls
          typed_config:
            '@type': type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
            common_tls_context:
              # HTTP/1.1 only, as on port 8000: WebSockets (Realtime) upgrade
              # the usual way.
              alpn_protocols: ["http/1.1"]
              tls_params:
                tls_minimum_protocol_version: TLSv1_2
              tls_certificate_sds_secret_configs:
                - name: ` + tlscert.SDSSecret + `
                  sds_config:
                    path_config_source:
                      path: ` + tlscert.MountPath + `/` + tlscert.SDSFile + `
                      watched_directory:
                        path: ` + tlscert.MountPath + `
                    resource_api_version: V3
        filters:
`

// redirectChain answers plain HTTP on the TLS port with a redirect to the
// same address over HTTPS (308 keeps the method and body).
const redirectChain = `    default_filter_chain:
      filters:
        - name: envoy.filters.network.http_connection_manager
          typed_config:
            '@type': >-
              type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
            stat_prefix: ingress_http_redirect
            route_config:
              name: https_redirect
              virtual_hosts:
                - name: https_redirect
                  domains: ['*']
                  routes:
                    - match:
                        prefix: /
                      redirect:
                        https_redirect: true
                        response_code: PERMANENT_REDIRECT
            http_filters:
              - name: envoy.filters.http.router
                typed_config:
                  '@type': type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
`

// tlsListener adds a TLS listener on EnvoyTLSPort to Envoy's listener
// template: a copy of the plain one (the same routes, keys and filters)
// that ends TLS first. It works on the template's text, and fails if
// Supabase's template has changed shape, rather than guess.
func tlsListener(lds string) (string, error) {
	fail := func(what string) (string, error) {
		return "", fmt.Errorf("%s: %s; update tlsListener for this template", ldsFile, what)
	}
	if strings.Count(lds, listenerStart) != 1 {
		return fail("expected exactly one listener")
	}
	listener := lds[strings.Index(lds, listenerStart):]
	if strings.Contains(listener[len(listenerStart):], "\n  - ") {
		return fail("expected the listener to be the last resource")
	}
	for _, s := range []string{listenerName, listenerPort, filterChains} {
		if strings.Count(listener, s) != 1 {
			return fail(fmt.Sprintf("expected one %q", strings.TrimSpace(s)))
		}
	}
	if strings.Contains(listener, "default_filter_chain:") || strings.Contains(listener, "listener_filters:") {
		return fail("the listener already has listener_filters or a default_filter_chain")
	}
	tls := strings.NewReplacer(
		listenerName, "    name: supabase_tls\n",
		listenerPort, fmt.Sprintf("        port_value: %d\n", EnvoyTLSPort),
		filterChains, tlsListenerChains,
	).Replace(listener)
	tls = strings.TrimRight(tls, "\n") + "\n" + redirectChain
	return strings.TrimRight(lds, "\n") + "\n\n# Supermixer: the same listener with TLS, on the stack's published port.\n" + tls, nil
}

// gatewayTLS, in the overlay of a stack with TLS: the API port goes to the
// TLS listener instead of 8000 (!override, or Compose would publish both
// on the same host port: Compose 2.24.4 or later), Envoy gets the listener
// template with it, and the certificate folder.
var gatewayTLS = `    ports: !override
      - ${API_GW_HTTP_PORT:-${KONG_HTTP_PORT:-8000}}:` + fmt.Sprint(EnvoyTLSPort) + `/tcp
    volumes:
      - ./` + ldsTLSFile + `:/etc/envoy/lds.template.yaml:ro,z
      - ../` + tlscert.ExportDirName + `:` + tlscert.MountPath + `:ro,z
`

// supavisorTLSVolume and supavisorTLSEnv give the pooler the certificate.
// Only with TLS: Supavisor won't start if the files it's pointed at are
// missing.
var (
	supavisorTLSVolume = `      - ../` + tlscert.ExportDirName + `:` + tlscert.MountPath + `:ro,z
`
	supavisorTLSEnv = `      GLOBAL_DOWNSTREAM_CERT_PATH: ` + tlscert.MountPath + `/` + tlscert.FullchainFile + `
      GLOBAL_DOWNSTREAM_KEY_PATH: ` + tlscert.MountPath + `/` + tlscert.KeyFile + `
`
)

// The pooler's start-up script, and Supermixer's version of it.
const (
	poolerScript     = "volumes/pooler/pooler.exs"
	poolerScriptFile = "volumes/pooler/pooler.supermixer.exs"
)

// enforceSSL, after the stack's pooler.exs (which creates the tenant),
// makes the tenant require TLS of clients when SUPERMIXER_POOLER_ENFORCE_SSL
// says so, and stop requiring it when not. Supavisor runs the script before
// it starts serving, on every start.
const enforceSSL = `

# Supermixer: require TLS of clients exactly when the stack uses it.
enforce_ssl = System.get_env("SUPERMIXER_POOLER_ENFORCE_SSL") == "true"

case Supavisor.Tenants.get_tenant_by_external_id(System.get_env("POOLER_TENANT_ID")) do
  nil -> :ok
  %{enforce_ssl: ^enforce_ssl} -> :ok
  tenant -> {:ok, _} = Supavisor.Tenants.update_tenant(tenant, %{"enforce_ssl" => enforce_ssl})
end
`

// poolerWithTLS is the stack's pooler.exs with enforceSSL after it.
func poolerWithTLS(script string) (string, error) {
	for _, s := range []string{"Application.ensure_all_started(:supavisor)", `System.get_env("POOLER_TENANT_ID")`, "Supavisor.Tenants.create_tenant"} {
		if !strings.Contains(script, s) {
			return "", fmt.Errorf("%s: expected %s; update poolerWithTLS for this template", poolerScript, s)
		}
	}
	return strings.TrimRight(script, "\n") + enforceSSL, nil
}

// writeTLSFiles writes what the overlay mounts: Supermixer's pooler.exs
// always, and Envoy's TLS listener template when the stack uses TLS. Both
// follow the stack's own files, so they're redone after an upgrade.
func writeTLSFiles(stackDir string, tls bool) error {
	b, err := os.ReadFile(filepath.Join(stackDir, filepath.FromSlash(poolerScript)))
	if errors.Is(err, fs.ErrNotExist) {
		b, err = fs.ReadFile(templateFS, "template/"+poolerScript) // the bundled template's
	}
	if err != nil {
		return fmt.Errorf("reading the pooler's script: %w", err)
	}
	pooler, err := poolerWithTLS(string(b))
	if err != nil {
		if tls {
			return err
		}
		// A template this doesn't know: a stack without TLS runs its own
		// script as it is (only a stack that had TLS needs enforce_ssl reset).
		pooler = string(b)
	}
	out := filepath.Join(stackDir, filepath.FromSlash(poolerScriptFile))
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(out, []byte(pooler), 0o644); err != nil {
		return err
	}
	if !tls {
		return nil
	}
	b, err = os.ReadFile(filepath.Join(stackDir, filepath.FromSlash(ldsFile)))
	if err != nil {
		return fmt.Errorf("reading the gateway's listener: %w", err)
	}
	lds, err := tlsListener(string(b))
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(stackDir, filepath.FromSlash(ldsTLSFile)), []byte(lds), 0o644)
}
