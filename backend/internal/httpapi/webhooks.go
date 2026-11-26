package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

// Organizations' webhooks: the organization's audit log entries, POSTed one
// at a time and in order (like audit drains, each webhook keeps its position
// in the audit log), signed with the webhook's secret. Owners manage them
// (org:update): they send the organization's events outside.
//
// A webhook whose kind is a chat app (chat.go) posts readable messages to the
// app's incoming webhook instead. Its address is the credential, so it's
// sealed in `secret`, and `url` keeps only its scheme and host.

const (
	// Up to this many webhooks, and as many chat channels.
	maxWebhooksPerOrg  = 10
	webhookBatch       = 100
	webhookMaxDelay    = time.Hour
	webhookParallel    = 8
	webhookSecretBytes = 32
)

// webhookPoll is how often webhooks look for new entries (and the shortest
// retry); entries written on this instance wake them sooner.
var webhookPoll = 5 * time.Second

var webhookEventPattern = regexp.MustCompile(`^(\*|[a-z_]+\.[a-z_]*)$`)

func webhookAD(org uuid.UUID) []byte { return []byte("supermixer webhook secret " + org.String()) }

// webhookEvent is what's POSTed for each entry.
type webhookEvent struct {
	ID           int64     `json:"id"`
	Type         string    `json:"type"`
	CreatedAt    time.Time `json:"created_at"`
	Organization string    `json:"organization"`
	Project      *string   `json:"project"`
	Actor        *struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	} `json:"actor"`
	Target struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"target"`
	Data json.RawMessage `json:"data"`
}

func toWebhookEvent(org string, r db.WebhookEntriesAfterRow) webhookEvent {
	e := webhookEvent{ID: r.ID, Type: r.Action, CreatedAt: r.CreatedAt.UTC(), Organization: org, Project: r.ProjectRef, Data: r.Metadata}
	if r.ActorID != nil {
		e.Actor = &struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		}{r.ActorID.String(), r.ActorUsername}
	}
	e.Target.Type, e.Target.ID, e.Target.Name = r.TargetType, r.TargetID, r.TargetName
	if len(e.Data) == 0 {
		e.Data = json.RawMessage("{}")
	}
	return e
}

// --- addresses webhooks may reach ---------------------------------------

var blockedPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, p := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
		"::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b::/96",
	} {
		out = append(out, netip.MustParsePrefix(p))
	}
	return out
}()

// blockedAddr reports whether an address is loopback, private, link-local
// or otherwise not on the public internet.
func blockedAddr(a netip.Addr) bool {
	a = a.Unmap()
	for _, p := range blockedPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// webhookClient POSTs webhooks. Unless private addresses are allowed, it
// refuses to connect to them, checking the address actually dialled (after
// DNS, so a public name pointing inside doesn't get through). No proxy from
// the environment, and redirects aren't followed.
func webhookClient(allowPrivate bool) *http.Client {
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if !allowPrivate {
		d.Control = func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || blockedAddr(ap.Addr()) {
				return fmt.Errorf("%s is a private or local address, which webhooks may not reach (webhooks.allow_private_addresses)", address)
			}
			return nil
		}
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.DialContext = d.DialContext
	return &http.Client{
		Transport:     t,
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func (h *handlers) validWebhookURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || len(raw) > 2048 {
		return "", badRequest("the URL must be an http(s) URL")
	}
	if u.User != nil {
		return "", badRequest("the URL can't hold a user name or password: webhook requests are signed (X-Supermixer-Signature), and chat apps' incoming webhook URLs don't need one")
	}
	if !h.deps.Config.Webhooks.AllowPrivateAddresses {
		host := strings.ToLower(u.Hostname())
		if a, err := netip.ParseAddr(host); (err == nil && blockedAddr(a)) || host == "localhost" || strings.HasSuffix(host, ".localhost") {
			return "", badRequest("webhooks may only reach public addresses on this instance (webhooks.allow_private_addresses)")
		}
	}
	return u.String(), nil
}

func validWebhookEvents(in []string) ([]string, error) {
	var out []string
	for _, e := range in {
		e = strings.TrimSpace(e)
		if !webhookEventPattern.MatchString(e) {
			return nil, badRequest("events are action prefixes such as project. or member.joined, or * for all; got %q", e)
		}
		if e == "*" {
			return []string{"*"}, nil
		}
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	if len(out) == 0 {
		return nil, badRequest("choose at least one kind of event")
	}
	return out, nil
}

func webhookWants(events []string, action string) bool {
	for _, e := range events {
		if e == "*" || strings.HasPrefix(action, e) {
			return true
		}
	}
	return false
}

// signWebhook is X-Supermixer-Signature's v1: HMAC-SHA256 of "<t>.<body>".
func signWebhook(secret string, t int64, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(m, "%d.", t)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

// sendWebhook makes one attempt: the HTTP status (0 if none), and why it
// failed.
// For a chat channel, secret is the address and orgName goes in the message.
func (h *handlers) sendWebhook(ctx context.Context, w db.OrgWebhook, secret, orgName string, ev webhookEvent) (int, error) {
	var req *http.Request
	if isChatKind(w.Kind) {
		body, err := chatBody(w.Kind, toChatMessage(ev, orgName, h.deps.Config.Server.PublicURL))
		if err != nil {
			return 0, err
		}
		// The address is the credential: errors name only its host.
		if req, err = http.NewRequestWithContext(ctx, http.MethodPost, secret, bytes.NewReader(body)); err != nil {
			return 0, fmt.Errorf("the chat channel's address is not a URL")
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Supermixer-Webhooks")
	} else {
		body, err := json.Marshal(ev)
		if err != nil {
			return 0, err
		}
		if req, err = http.NewRequestWithContext(ctx, http.MethodPost, w.Url, bytes.NewReader(body)); err != nil {
			return 0, err
		}
		now := time.Now().Unix()
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Supermixer-Webhooks")
		req.Header.Set("X-Supermixer-Event", ev.Type)
		req.Header.Set("X-Supermixer-Delivery", fmt.Sprint(ev.ID))
		req.Header.Set("X-Supermixer-Signature", fmt.Sprintf("t=%d,v1=%s", now, signWebhook(secret, now, body)))
	}
	resp, err := h.webhookHTTP.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return 0, fmt.Errorf("POST %s: %w", redactURL(w.Url), err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	switch {
	case resp.StatusCode/100 == 2:
		return resp.StatusCode, nil
	case resp.StatusCode/100 == 3:
		return resp.StatusCode, fmt.Errorf("answered %s, a redirect: use the URL it points to", resp.Status)
	default:
		return resp.StatusCode, fmt.Errorf("answered %s", resp.Status)
	}
}

// attemptWebhook sends and records one attempt.
func (h *handlers) attemptWebhook(ctx context.Context, w db.OrgWebhook, secret, orgName string, ev webhookEvent) (api.WebhookDelivery, error) {
	start := time.Now()
	status, err := h.sendWebhook(ctx, w, secret, orgName, ev)
	d := api.WebhookDelivery{EventId: ev.ID, Event: ev.Type, Status: status, DurationMs: int(time.Since(start).Milliseconds()), CreatedAt: time.Now()}
	if err != nil {
		d.Error = truncate(err.Error(), 500)
	}
	if ctx.Err() == nil {
		_ = h.deps.Store.Queries.AddWebhookDelivery(ctx, db.AddWebhookDeliveryParams{WebhookID: w.ID, EventID: ev.ID,
			Event: ev.Type, Status: int32(status), Error: d.Error, DurationMs: int32(d.DurationMs)})
	}
	return d, err
}

func (h *handlers) webhookSecret(w db.OrgWebhook) (string, error) {
	b, err := h.deps.Box.Open(w.Secret, webhookAD(w.OrganizationID))
	return string(b), err
}

// --- delivery -----------------------------------------------------------

// webhookLoop delivers every enabled webhook's events until ctx ends: a few
// webhooks at a time, each backing off on its own while it fails.
func (h *handlers) webhookLoop(ctx context.Context) {
	wake, stop := h.auditWritten.subscribe()
	defer stop()
	var (
		mu      sync.Mutex
		busy    = map[uuid.UUID]bool{}
		delay   = map[uuid.UUID]time.Duration{}
		next    = map[uuid.UUID]time.Time{}
		wg      sync.WaitGroup
		slots   = make(chan struct{}, webhookParallel)
		pending = false
	)
	defer wg.Wait()
	for {
		mu.Lock()
		more := pending // a webhook stopped with more waiting: go again now
		pending = false
		mu.Unlock()
		if !more {
			select {
			case <-ctx.Done():
				return
			case <-wake:
			case <-time.After(webhookPoll):
			}
		}
		hooks, err := h.deps.Store.Queries.ListEnabledWebhooks(ctx)
		if err != nil {
			continue
		}
		now := time.Now()
		for _, row := range hooks {
			w := row.OrgWebhook
			mu.Lock()
			if w.FailingSince == nil && !busy[w.ID] {
				// Not failing (fixed, or turned off and on): no backoff.
				delete(delay, w.ID)
				delete(next, w.ID)
			}
			skip := busy[w.ID] || now.Before(next[w.ID])
			if !skip {
				busy[w.ID] = true
			}
			mu.Unlock()
			if skip {
				continue
			}
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			wg.Add(1)
			go func(w db.OrgWebhook, org, orgName string) {
				defer wg.Done()
				defer func() { <-slots }()
				more, err := h.webhookPass(ctx, w, org, orgName)
				mu.Lock()
				defer mu.Unlock()
				busy[w.ID] = false
				if err != nil && ctx.Err() == nil {
					delay[w.ID] = min(max(2*delay[w.ID], webhookPoll), webhookMaxDelay)
					next[w.ID] = time.Now().Add(delay[w.ID])
					h.deps.Logger.Warn("webhook: delivery failed; will retry", "webhook", w.ID, "organization", org,
						"retry_in", delay[w.ID], "err", err)
				} else {
					delete(delay, w.ID)
					delete(next, w.ID)
					if more {
						pending = true
					}
				}
			}(w, row.OrganizationSlug, row.OrganizationName)
		}
	}
}

// webhookPass sends what's waiting for one webhook, up to a few batches:
// whether more may be waiting, and why it stopped if it failed.
func (h *handlers) webhookPass(ctx context.Context, w db.OrgWebhook, org, orgName string) (bool, error) {
	q := h.deps.Store.Queries
	secret, err := h.webhookSecret(w)
	if err != nil {
		return false, err
	}
	txid, id := w.LastTxid, w.LastID
	sent := 0
	defer func() {
		if ctx.Err() != nil {
			return
		}
		_ = q.AdvanceWebhook(context.WithoutCancel(ctx), db.AdvanceWebhookParams{ID: w.ID, LastTxid: txid, LastID: id})
		if sent > 0 {
			_ = q.PruneWebhookDeliveries(context.WithoutCancel(ctx), w.ID)
		}
	}()
	for batch := 0; batch < 5; batch++ {
		rows, err := q.WebhookEntriesAfter(ctx, db.WebhookEntriesAfterParams{OrganizationID: &w.OrganizationID,
			LastTxid: txid, LastID: id, RowLimit: webhookBatch})
		if err != nil {
			return false, err
		}
		for _, r := range rows {
			if webhookWants(w.Events, r.Action) {
				if _, err := h.attemptWebhook(ctx, w, secret, orgName, toWebhookEvent(org, r)); err != nil {
					_ = q.WebhookFailed(context.WithoutCancel(ctx), db.WebhookFailedParams{ID: w.ID, LastError: truncate(err.Error(), 500)})
					return false, err
				}
				sent++
				if sent == 1 {
					_ = q.WebhookSucceeded(ctx, w.ID)
				}
			}
			txid, id = r.Txid, r.ID
		}
		if len(rows) < webhookBatch {
			return false, nil
		}
	}
	return true, nil
}

// --- API ----------------------------------------------------------------

func toWebhook(w db.OrgWebhook) api.Webhook {
	return api.Webhook{Id: w.ID, Kind: api.WebhookKind(w.Kind), Url: w.Url, Description: w.Description, Events: w.Events, Enabled: w.Enabled,
		CreatedAt: w.CreatedAt, LastSuccessAt: w.LastSuccessAt, LastError: w.LastError, FailingSince: w.FailingSince}
}

func newWebhookSecret() (string, error) {
	b := make([]byte, webhookSecretBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "whsec_" + base64.RawURLEncoding.EncodeToString(b), nil
}

func (h *handlers) webhookAudit(ctx context.Context, a *orgAccess, action string, w db.OrgWebhook, meta map[string]any) {
	if meta == nil {
		meta = map[string]any{}
	}
	meta["kind"] = w.Kind
	h.audit(ctx, nil, auditEntry{OrgID: &a.Org.ID, Action: action, TargetType: "webhook", TargetID: w.ID.String(),
		TargetName: redactURL(w.Url), Metadata: meta})
}

func (h *handlers) loadWebhook(ctx context.Context, slug string, id uuid.UUID) (*orgAccess, db.OrgWebhook, error) {
	a, err := h.loadOrg(ctx, slug, rbac.OrgUpdate, "manage webhooks")
	if err != nil {
		return nil, db.OrgWebhook{}, err
	}
	w, err := h.deps.Store.Queries.GetWebhook(ctx, db.GetWebhookParams{ID: id, OrganizationID: a.Org.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, w, notFound("webhook")
	}
	return a, w, err
}

func (h *handlers) ListWebhooks(ctx context.Context, req api.ListWebhooksRequestObject) (api.ListWebhooksResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgUpdate, "manage webhooks")
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListWebhooks(ctx, a.Org.ID)
	if err != nil {
		return nil, err
	}
	out := api.ListWebhooks200JSONResponse{}
	for _, w := range rows {
		out = append(out, toWebhook(w))
	}
	return out, nil
}

func (h *handlers) CreateWebhook(ctx context.Context, req api.CreateWebhookRequestObject) (api.CreateWebhookResponseObject, error) {
	a, err := h.loadOrg(ctx, req.Slug, rbac.OrgUpdate, "manage webhooks")
	if err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	kind := kindWebhook
	if req.Body.Kind != nil {
		kind = string(*req.Body.Kind)
	}
	if kind != kindWebhook && !isChatKind(kind) {
		return nil, badRequest("unknown kind %q", kind)
	}
	u, err := h.validWebhookURL(req.Body.Url)
	if err != nil {
		return nil, err
	}
	if isChatKind(kind) {
		if err := chatAddressCheck(u); err != nil {
			return nil, err
		}
	}
	events, err := validWebhookEvents(req.Body.Events)
	if err != nil {
		return nil, err
	}
	desc := strings.TrimSpace(deref(req.Body.Description))
	if len(desc) > 200 {
		return nil, badRequest("the description is at most 200 characters")
	}
	existing, err := q.ListWebhooks(ctx, a.Org.ID)
	if err != nil {
		return nil, err
	}
	same := 0
	for _, w := range existing {
		if isChatKind(w.Kind) == isChatKind(kind) {
			same++
		}
	}
	if same >= maxWebhooksPerOrg {
		if isChatKind(kind) {
			return nil, conflict("an organization can have up to %d chat channels", maxWebhooksPerOrg)
		}
		return nil, conflict("an organization can have up to %d webhooks", maxWebhooksPerOrg)
	}
	// A webhook's sealed secret signs its requests; a chat channel's is its
	// address, and only the address's host is kept in the open.
	secret, sealedValue, shown := "", "", u
	if isChatKind(kind) {
		sealedValue, shown = u, chatDisplayURL(u)
	} else {
		if secret, err = newWebhookSecret(); err != nil {
			return nil, err
		}
		sealedValue = secret
	}
	sealed, err := h.deps.Box.Seal([]byte(sealedValue), webhookAD(a.Org.ID))
	if err != nil {
		return nil, err
	}
	w, err := q.CreateWebhook(ctx, db.CreateWebhookParams{OrganizationID: a.Org.ID, Kind: kind, Url: shown, Description: desc,
		Events: events, Secret: sealed, CreatedBy: &a.User.User.ID})
	if err != nil {
		return nil, err
	}
	h.webhookAudit(ctx, a, "webhook.created", w, map[string]any{"events": events})
	return api.CreateWebhook201JSONResponse{Webhook: toWebhook(w), Secret: secret}, nil
}

func (h *handlers) UpdateWebhook(ctx context.Context, req api.UpdateWebhookRequestObject) (api.UpdateWebhookResponseObject, error) {
	a, w, err := h.loadWebhook(ctx, req.Slug, req.WebhookId)
	if err != nil {
		return nil, err
	}
	b := req.Body
	p := db.UpdateWebhookParams{ID: w.ID, OrganizationID: a.Org.ID, Url: w.Url, Description: w.Description, Events: w.Events, Enabled: w.Enabled}
	switch {
	case b.Url == nil:
	case !isChatKind(w.Kind):
		if p.Url, err = h.validWebhookURL(*b.Url); err != nil {
			return nil, err
		}
	case strings.TrimSpace(*b.Url) == "":
		// A chat channel's address left empty is kept.
	default:
		u, err := h.validWebhookURL(*b.Url)
		if err != nil {
			return nil, err
		}
		if chatBareHost(u) && chatDisplayURL(u) == w.Url {
			break // the host shown, sent back: kept
		}
		if err := chatAddressCheck(u); err != nil {
			return nil, err
		}
		old, err := h.webhookSecret(w)
		if err != nil {
			return nil, err
		}
		if u != old {
			// A new address: sealed, and only its host kept in the open.
			if p.Secret, err = h.deps.Box.Seal([]byte(u), webhookAD(a.Org.ID)); err != nil {
				return nil, err
			}
			p.Url = chatDisplayURL(u)
		}
	}
	if b.Events != nil {
		if p.Events, err = validWebhookEvents(*b.Events); err != nil {
			return nil, err
		}
	}
	if b.Description != nil {
		if p.Description = strings.TrimSpace(*b.Description); len(p.Description) > 200 {
			return nil, badRequest("the description is at most 200 characters")
		}
	}
	if b.Enabled != nil {
		p.Enabled = *b.Enabled
	}
	updated, err := h.deps.Store.Queries.UpdateWebhook(ctx, p)
	if err != nil {
		return nil, err
	}
	meta := map[string]any{}
	if updated.Url != w.Url {
		meta["previous_url"] = redactURL(w.Url)
	}
	if p.Secret != nil && isChatKind(w.Kind) {
		meta["address_changed"] = true
	}
	if !slices.Equal(updated.Events, w.Events) {
		meta["events"] = updated.Events
	}
	if updated.Enabled != w.Enabled {
		meta["enabled"] = updated.Enabled
	}
	h.webhookAudit(ctx, a, "webhook.updated", updated, meta)
	return api.UpdateWebhook200JSONResponse(toWebhook(updated)), nil
}

func (h *handlers) DeleteWebhook(ctx context.Context, req api.DeleteWebhookRequestObject) (api.DeleteWebhookResponseObject, error) {
	a, w, err := h.loadWebhook(ctx, req.Slug, req.WebhookId)
	if err != nil {
		return nil, err
	}
	if _, err := h.deps.Store.Queries.DeleteWebhook(ctx, db.DeleteWebhookParams{ID: w.ID, OrganizationID: a.Org.ID}); err != nil {
		return nil, err
	}
	h.webhookAudit(ctx, a, "webhook.deleted", w, nil)
	return api.DeleteWebhook204Response{}, nil
}

func (h *handlers) RotateWebhookSecret(ctx context.Context, req api.RotateWebhookSecretRequestObject) (api.RotateWebhookSecretResponseObject, error) {
	a, w, err := h.loadWebhook(ctx, req.Slug, req.WebhookId)
	if err != nil {
		return nil, err
	}
	if isChatKind(w.Kind) {
		return nil, badRequest("chat channels have no signing secret; to change the address, edit the channel")
	}
	secret, err := newWebhookSecret()
	if err != nil {
		return nil, err
	}
	sealed, err := h.deps.Box.Seal([]byte(secret), webhookAD(a.Org.ID))
	if err != nil {
		return nil, err
	}
	if err := h.deps.Store.Queries.SetWebhookSecret(ctx, db.SetWebhookSecretParams{ID: w.ID, Secret: sealed}); err != nil {
		return nil, err
	}
	h.webhookAudit(ctx, a, "webhook.secret_rotated", w, nil)
	return api.RotateWebhookSecret200JSONResponse{Secret: secret}, nil
}

func (h *handlers) TestWebhook(ctx context.Context, req api.TestWebhookRequestObject) (api.TestWebhookResponseObject, error) {
	a, w, err := h.loadWebhook(ctx, req.Slug, req.WebhookId)
	if err != nil {
		return nil, err
	}
	secret, err := h.webhookSecret(w)
	if err != nil {
		return nil, err
	}
	ev := webhookEvent{ID: 0, Type: "webhook.test", CreatedAt: time.Now().UTC(), Organization: a.Org.Slug, Data: json.RawMessage(`{}`)}
	ev.Actor = &struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	}{a.User.User.ID.String(), a.User.User.Username}
	ev.Target.Type, ev.Target.ID, ev.Target.Name = "webhook", w.ID.String(), redactURL(w.Url)
	d, _ := h.attemptWebhook(ctx, w, secret, a.Org.Name, ev)
	return api.TestWebhook200JSONResponse(d), nil
}

func (h *handlers) ListWebhookDeliveries(ctx context.Context, req api.ListWebhookDeliveriesRequestObject) (api.ListWebhookDeliveriesResponseObject, error) {
	_, w, err := h.loadWebhook(ctx, req.Slug, req.WebhookId)
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListWebhookDeliveries(ctx, w.ID)
	if err != nil {
		return nil, err
	}
	out := api.ListWebhookDeliveries200JSONResponse{}
	for _, r := range rows {
		out = append(out, api.WebhookDelivery{Id: r.ID, EventId: r.EventID, Event: r.Event, Status: int(r.Status),
			Error: r.Error, DurationMs: int(r.DurationMs), CreatedAt: r.CreatedAt})
	}
	return out, nil
}
