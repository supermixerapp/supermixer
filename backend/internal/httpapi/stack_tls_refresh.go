package httpapi

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"supermixer/internal/api"
	"supermixer/internal/store/db"
)

// How long a stack gets to pick up a new certificate by itself before
// Supermixer recreates the container that serves the old one. Envoy
// reloads when the folder changes (not through Docker Desktop's file
// sharing, which passes no change events); Supavisor rereads its files
// within about two minutes.
var (
	gatewayCertGrace = 30 * time.Second
	poolerCertGrace  = 3 * time.Minute
)

// applyTLS, on the instance doing the background work: with [tls] off,
// running stacks that use TLS go back to plain HTTP, since nothing would
// renew their certificate. With it on, each new certificate reaches the
// running stacks (refreshStackCerts). Existing plain stacks aren't
// switched: that changes their clients' URLs, so it's done per project.
func (h *handlers) applyTLS(ctx context.Context) {
	if !h.deps.Config.Provisioning.Enabled || h.deps.Store == nil {
		return
	}
	if !h.deps.TLS.Enabled() {
		h.plainStacks(ctx)
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.certChanged:
		}
		h.refreshStackCerts(ctx)
	}
}

func (h *handlers) runningStacks(ctx context.Context) []db.Project {
	rows, err := h.deps.Store.Queries.ListStacksWithStatus(ctx, db.ListStacksWithStatusParams{
		Statuses: []string{string(db.StackStatusRunning)}, Before: time.Now(),
	})
	if err != nil {
		h.deps.Logger.ErrorContext(ctx, "tls: listing the stacks", "err", err)
	}
	return rows
}

// plainStacks switches running stacks that use TLS back to plain HTTP.
func (h *handlers) plainStacks(ctx context.Context) {
	for _, p := range h.runningStacks(ctx) {
		if ctx.Err() != nil {
			return
		}
		if !h.stackTLS(p.Ref) || !h.stacks.begin(p.Ref, api.StackOperationUpdating) {
			continue
		}
		if h.hstsPinsStacks() {
			h.deps.Logger.WarnContext(ctx, "tls: a stack goes back to plain HTTP on a host name with HSTS; browsers that saw it will refuse the stack",
				"project", p.Ref)
		}
		err := func() error {
			ctx, cancel := context.WithTimeout(ctx, h.deps.Config.Provisioning.StartTimeout)
			defer cancel()
			log := &stackLog{dir: h.stackLayout(p.Ref).Dir}
			defer log.Close()
			fmt.Fprintf(log, "\n== %s: Turning TLS off (tls.mode is off in Supermixer's settings) ==\n", time.Now().UTC().Format(time.RFC3339))
			return h.switchTLS(ctx, p, false, log)
		}()
		h.stacks.end(p.Ref)
		if err != nil {
			h.deps.Logger.WarnContext(ctx, "tls: turning TLS off for a stack", "project", p.Ref, "err", err)
			continue
		}
		h.setManagedAddresses(ctx, p, false)
		h.audit(ctx, nil, auditEntry{OrgID: &p.OrganizationID, ProjectID: &p.ID, Action: "project.tls_updated",
			TargetType: "project", TargetID: p.Ref, TargetName: p.Name,
			Metadata: map[string]any{"enabled": false, "reason": "tls.mode is off"}})
		h.deps.Logger.InfoContext(ctx, "tls: turned TLS off for a stack (tls.mode is off)", "project", p.Ref)
	}
}

// refreshStackCerts makes sure running TLS stacks serve the current
// certificate, recreating the gateway or pooler of any that still serve an
// older one once they've had time to pick it up themselves.
func (h *handlers) refreshStackCerts(ctx context.Context) {
	host := strings.Trim(h.deps.Config.Provisioning.PublicHost, "[]")
	cert := h.deps.TLS.Certificate(host)
	if cert == nil {
		return
	}
	want := cert.Certificate[0]
	for _, step := range []struct {
		service string
		grace   time.Duration
		port    func(db.Project) int
		served  func(context.Context, string, int) ([]byte, error)
	}{
		{"api-gw", gatewayCertGrace, func(p db.Project) int { return int(*p.StackApiPort) }, h.servedHTTPS},
		{"supavisor", poolerCertGrace - gatewayCertGrace, func(p db.Project) int { return int(*p.StackDbPort) }, h.servedPostgres},
	} {
		select {
		case <-ctx.Done():
			return
		case <-time.After(step.grace):
		}
		if !h.deps.TLS.Issued(want) {
			return // newer still: its own refresh follows
		}
		for _, p := range h.runningStacks(ctx) {
			if ctx.Err() != nil || !h.stackTLS(p.Ref) || p.StackApiPort == nil || p.StackDbPort == nil {
				continue
			}
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			got, err := step.served(cctx, host, step.port(p))
			cancel()
			if err == nil && string(got) == string(want) {
				continue
			}
			if !h.stacks.begin(p.Ref, api.StackOperationUpdating) {
				continue // busy; it gets the files when that finishes
			}
			rerr := func() error {
				rctx, cancel := context.WithTimeout(ctx, h.deps.Config.Provisioning.StartTimeout)
				defer cancel()
				log := &stackLog{dir: h.stackLayout(p.Ref).Dir}
				defer log.Close()
				fmt.Fprintf(log, "\n== %s: Recreating %s for the new certificate ==\n", time.Now().UTC().Format(time.RFC3339), step.service)
				return h.compose(p.Ref).Recreate(rctx, log, step.service)
			}()
			h.stacks.end(p.Ref)
			if rerr != nil {
				h.deps.Logger.WarnContext(ctx, "tls: recreating a service for the new certificate", "project", p.Ref, "service", step.service, "err", rerr)
				continue
			}
			h.deps.Logger.InfoContext(ctx, "tls: recreated a service for the new certificate", "project", p.Ref, "service", step.service)
		}
	}
}

// servedHTTPS is the certificate (DER) a stack's API port serves.
func (h *handlers) servedHTTPS(ctx context.Context, host string, port int) ([]byte, error) {
	conn, err := h.network.Dial(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	return peerCertificate(ctx, conn, host)
}

// servedPostgres is the certificate a stack's Postgres port serves, after
// Postgres's SSLRequest.
func (h *handlers) servedPostgres(ctx context.Context, host string, port int) ([]byte, error) {
	conn, err := h.network.Dial(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if d, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(d)
	}
	req := make([]byte, 8)
	binary.BigEndian.PutUint32(req[0:4], 8)
	binary.BigEndian.PutUint32(req[4:8], 80877103) // SSLRequest
	if _, err := conn.Write(req); err != nil {
		return nil, err
	}
	answer := make([]byte, 1)
	if _, err := io.ReadFull(conn, answer); err != nil {
		return nil, err
	}
	if answer[0] != 'S' {
		return nil, errors.New("the pooler doesn't offer TLS")
	}
	return peerCertificate(ctx, conn, host)
}

// peerCertificate completes a TLS handshake only to see the certificate:
// it's compared with Supermixer's own, not trusted.
func peerCertificate(ctx context.Context, conn net.Conn, host string) ([]byte, error) {
	c := tls.Client(conn, &tls.Config{ServerName: host, InsecureSkipVerify: true}) //nolint:gosec // compared, not trusted
	if err := c.HandshakeContext(ctx); err != nil {
		return nil, err
	}
	certs := c.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return nil, errors.New("no certificate")
	}
	return certs[0].Raw, nil
}
