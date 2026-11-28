package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/provision"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// stackTLS reports whether a stack uses TLS, as its .env records it.
func (h *handlers) stackTLS(ref string) bool {
	env, err := provision.ReadEnv(h.stackLayout(ref).Dir)
	return err == nil && provision.TLSOf(env)
}

// stackTLSEnv is a stack's .env settings that follow TLS: its public URLs.
func (h *handlers) stackTLSEnv(p db.Project, on bool) map[string]string {
	public := publicURL(h.deps.Config.Provisioning, int(*p.StackApiPort), on)
	return map[string]string{"SUPABASE_PUBLIC_URL": public, "API_EXTERNAL_URL": public + "/auth/v1"}
}

// checkStackTLS refuses TLS for a stack when this server can't give it:
// no certificate for public_host yet, or a Docker Compose too old for the
// overlay's !override.
func (h *handlers) checkStackTLS(ctx context.Context, on bool) error {
	if !on {
		return nil
	}
	host := strings.Trim(h.deps.Config.Provisioning.PublicHost, "[]")
	if !h.deps.TLS.Ready(host) {
		return &apiError{status: http.StatusServiceUnavailable, code: "certificate_not_ready",
			message: "Supermixer has no certificate for " + host + " yet; try again in a minute, or see Instance › Overview"}
	}
	if !h.composeTLSOK.Load() {
		if v, err := provision.ComposeVersion(ctx, h.deps.Config.Provisioning.Docker); err == nil {
			if !provision.ComposeAtLeast(v, provision.MinComposeTLS) {
				return &apiError{status: http.StatusServiceUnavailable, code: "docker_compose_too_old",
					message: fmt.Sprintf("docker compose %s is too old for stacks with TLS, which need %s or later; upgrade Docker Compose",
						v, provision.MinComposeTLS)}
			}
			h.composeTLSOK.Store(true)
		}
	}
	return nil
}

// prepareStackTLS, before a stack starts: a TLS stack gets the current
// certificate written out for it, or, when Supermixer no longer has one
// ([tls] is off), switches to plain HTTP, since nothing would renew it.
func (h *handlers) prepareStackTLS(ctx context.Context, ref string, log io.Writer) error {
	if !h.stackTLS(ref) {
		return nil
	}
	if !h.deps.TLS.Enabled() {
		fmt.Fprintln(log, "TLS is off in Supermixer's settings, so this stack switches to plain HTTP")
		row, err := h.deps.Store.Queries.GetProjectByRef(ctx, ref)
		if err != nil {
			return err
		}
		if err := provision.SetTLS(h.stackLayout(ref).Dir, false, h.stackTLSEnv(row.Project, false)); err != nil {
			return fmt.Errorf("updating the stack's files: %w", err)
		}
		h.setManagedAddresses(ctx, row.Project, false)
		h.audit(ctx, nil, auditEntry{OrgID: &row.Project.OrganizationID, ProjectID: &row.Project.ID, Action: "project.tls_updated",
			TargetType: "project", TargetID: ref, TargetName: row.Project.Name,
			Metadata: map[string]any{"enabled": false, "reason": "tls.mode is off"}})
		return nil
	}
	if err := h.checkStackTLS(ctx, true); err != nil {
		return err
	}
	if err := h.deps.TLS.Export(); err != nil {
		return fmt.Errorf("writing the certificate for the stack: %w", err)
	}
	return nil
}

// SetStackTls turns TLS on or off for a stack. A running stack is brought
// up on its new files in the background (Compose recreates the services
// whose settings change: the gateway, the pooler, and those that use the
// public URL); otherwise the files change, for its next start. The row's
// addresses change once it's done.
func (h *handlers) SetStackTls(ctx context.Context, req api.SetStackTlsRequestObject) (api.SetStackTlsResponseObject, error) {
	_, p, err := h.managedStack(ctx, req.Ref, rbac.ProjectUpdate, "turn TLS on or off for this project")
	if err != nil {
		return nil, err
	}
	if !h.deps.Config.Provisioning.Enabled {
		return nil, errProvisioningOff()
	}
	on := req.Body.Enabled
	if h.stackTLS(p.Ref) != on {
		if on && !h.deps.TLS.Enabled() {
			return nil, conflict("Supermixer has no certificate: an instance admin sets one up under [tls] in its settings")
		}
		if err := h.checkStackTLS(ctx, on); err != nil {
			return nil, err
		}
		if !h.stacks.begin(p.Ref, api.StackOperationUpdating) {
			return nil, conflict("the stack is busy with another operation; wait for it to finish")
		}
		// Read again now that no other operation can change it.
		row, err := h.deps.Store.Queries.GetProjectByRef(ctx, p.Ref)
		if err != nil {
			h.stacks.end(p.Ref)
			return nil, err
		}
		p = row.Project
		done := func(ctx context.Context) {
			h.setManagedAddresses(ctx, p, on)
			h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.tls_updated",
				TargetType: "project", TargetID: p.Ref, TargetName: p.Name, Metadata: map[string]any{"enabled": on}})
		}
		switch p.StackStatus.StackStatus {
		case db.StackStatusRunning:
			h.runStackHeld(ctx, p, api.StackOperationUpdating, db.StackStatusRunning, h.deps.Config.Provisioning.StartTimeout,
				func(ctx context.Context, log io.Writer) error {
					if err := h.switchTLS(ctx, p, on, log); err != nil {
						return err
					}
					done(ctx)
					return nil
				})
		case db.StackStatusPaused, db.StackStatusFailed:
			err := provision.SetTLS(h.stackLayout(p.Ref).Dir, on, h.stackTLSEnv(p, on))
			h.stacks.end(p.Ref)
			if err != nil {
				return nil, fmt.Errorf("updating the stack's files: %w", err)
			}
			done(ctx)
		default:
			h.stacks.end(p.Ref)
			return nil, conflict("the stack is being created or deleted; wait for it to finish")
		}
	}
	out, err := h.stackDetail(ctx, p)
	if err != nil {
		return nil, err
	}
	out.Tls = on // on a running stack, what's being applied
	return api.SetStackTls202JSONResponse(out), nil
}

// switchTLS changes a running stack's files and brings it up on them. If
// that fails, the old files go back and the stack is brought up on them.
func (h *handlers) switchTLS(ctx context.Context, p db.Project, on bool, log io.Writer) error {
	dir := h.stackLayout(p.Ref).Dir
	what := map[bool]string{true: "turning TLS on", false: "turning TLS off"}[on]
	fmt.Fprintf(log, "%s\n", what)
	if err := provision.SetTLS(dir, on, h.stackTLSEnv(p, on)); err != nil {
		return &recoveredError{fmt.Errorf("didn't change TLS: updating the stack's files: %w", err)}
	}
	err := h.bringUp(ctx, p.Ref, log)
	if err == nil {
		return nil
	}
	fmt.Fprintf(log, "\n%s failed: %v; going back\n", what, err)
	if rerr := provision.SetTLS(dir, !on, h.stackTLSEnv(p, !on)); rerr != nil {
		return fmt.Errorf("%s failed (%v), and restoring the stack's files failed: %w", what, err, rerr)
	}
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), h.deps.Config.Provisioning.StartTimeout)
	defer cancel()
	if uerr := h.bringUp(bctx, p.Ref, log); uerr != nil {
		return fmt.Errorf("%s failed (%v), and the stack didn't come back up: %w", what, err, uerr)
	}
	return &recoveredError{fmt.Errorf("didn't change TLS: %w", err)}
}

// caCertificate serves Supermixer's private CA, so people can trust its
// HTTPS and its stacks' certificates. Without one (a public CA, or no TLS)
// there's nothing to download.
func (h *handlers) caCertificate(w http.ResponseWriter, _ *http.Request) {
	pem := h.deps.TLS.CAPEM()
	if pem == nil {
		writeError(w, http.StatusNotFound, "Supermixer doesn't use a CA of its own")
		return
	}
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="supermixer-ca.pem"`)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(pem)
}

// tlsStatus is the certificate and where it's used, for Instance ›
// Overview. Stacks are counted, not named: instance admins don't see
// projects' details.
func (h *handlers) tlsStatus(ctx context.Context) api.TlsStatus {
	st := h.deps.TLS.Status()
	out := api.TlsStatus{
		Mode: api.TlsStatusMode(st.Mode), Names: st.Names, PrivateCa: st.PrivateCA, Missing: st.Missing,
		Certificates: []struct {
			Issuer   string    `json:"issuer"`
			Names    []string  `json:"names"`
			NotAfter time.Time `json:"not_after"`
		}{},
	}
	if out.Names == nil {
		out.Names = []string{}
	}
	if out.Missing == nil {
		out.Missing = []string{}
	}
	for _, c := range st.Certs {
		out.Certificates = append(out.Certificates, struct {
			Issuer   string    `json:"issuer"`
			Names    []string  `json:"names"`
			NotAfter time.Time `json:"not_after"`
		}{c.Issuer, c.Names, c.NotAfter})
	}
	if st.LastError != "" {
		out.LastError, out.LastErrorAt = &st.LastError, &st.LastErrorAt
	}
	if l := h.deps.Config.Server.HTTPSListen; l != "" {
		out.HttpsListen = &l
	}
	if hsts := h.hstsHeader(); hsts != "" {
		if pu, err := url.Parse(h.deps.Config.Server.PublicURL); err == nil && h.hsts.safe(ctx, h, pu.Hostname()) {
			out.Hsts = &hsts
		} else {
			out.HstsBlocked = true
		}
	}
	if h.deps.Config.Provisioning.Enabled && h.deps.Store != nil {
		rows, _ := h.deps.Store.Queries.ListManagedProjects(ctx)
		for _, p := range rows {
			if h.stackTLS(p.Ref) {
				out.StacksTls++
			} else {
				out.StacksPlain++
			}
		}
	}
	return out
}
