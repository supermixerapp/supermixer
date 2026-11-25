package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/config"
	"supermixer/internal/store/db"
)

// Audit log drains: entries go to each drain in order, at
// least once. A drain's position (audit_drains.last_txid, last_id) moves
// only after a batch is delivered, so restarts and outages resume where
// they stopped.

const (
	drainBatch    = 500
	drainMaxDelay = 5 * time.Minute
)

// drainPoll is how often drains look for new entries (and the shortest
// retry); entries written on this instance wake them sooner.
var drainPoll = 5 * time.Second

// drainEntry is how an audit log entry is sent.
type drainEntry struct {
	ID     int64     `json:"id"`
	Time   time.Time `json:"time"`
	Action string    `json:"action"`
	Actor  *struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	} `json:"actor"`
	Organization *string `json:"organization"`
	Project      *string `json:"project"`
	Target       struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"target"`
	Metadata  json.RawMessage `json:"metadata"`
	IP        string          `json:"ip"`
	UserAgent string          `json:"user_agent"`
	Source    string          `json:"source"`
}

func toDrainEntry(r db.AuditLogsAfterRow) drainEntry {
	e := drainEntry{ID: r.ID, Time: r.CreatedAt.UTC(), Action: r.Action, Organization: r.OrganizationSlug, Project: r.ProjectRef,
		Metadata: r.Metadata, IP: r.Ip, UserAgent: r.UserAgent, Source: "supermixer"}
	if r.ActorID != nil {
		e.Actor = &struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		}{r.ActorID.String(), r.ActorUsername}
	}
	e.Target.Type, e.Target.ID, e.Target.Name = r.TargetType, r.TargetID, r.TargetName
	if len(e.Metadata) == 0 {
		e.Metadata = json.RawMessage("{}")
	}
	return e
}

// drainLoop runs every configured drain until ctx ends.
func (h *handlers) drainLoop(ctx context.Context) {
	var wg sync.WaitGroup
	for _, d := range h.deps.Config.Audit.Drains {
		wake, stop := h.auditWritten.subscribe()
		wg.Add(1)
		go func(d config.AuditDrain) {
			defer wg.Done()
			defer stop()
			h.runDrain(ctx, d, wake)
		}(d)
	}
	wg.Wait()
}

func (h *handlers) runDrain(ctx context.Context, d config.AuditDrain, wake <-chan struct{}) {
	q := h.deps.Store.Queries
	started := false
	delay := time.Duration(0) // while failing, how long until the next try
	fail := func(what string, err error) {
		delay = min(max(2*delay, drainPoll), drainMaxDelay)
		h.deps.Logger.Warn("audit drain: "+what+"; will retry", "drain", d.ID, "retry_in", delay, "err", err)
	}
	for {
		if delay > 0 {
			// Backing off: new entries don't hurry a retry.
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		} else {
			select {
			case <-ctx.Done():
				return
			case <-wake:
			case <-time.After(drainPoll):
			}
		}
		if !started {
			if err := q.EnsureAuditDrain(ctx, d.ID); err != nil {
				if ctx.Err() == nil {
					fail("couldn't start", err)
				}
				continue
			}
			started = true
		}
		sent, failed := h.drainPass(ctx, q, d)
		if ctx.Err() != nil {
			return
		}
		if failed != nil {
			fail("delivery failed", failed)
			_ = q.AuditDrainFailed(ctx, db.AuditDrainFailedParams{ID: d.ID, LastError: truncate(failed.Error(), 500)})
		} else {
			delay = 0
		}
		// The backlog, once per pass (a count over what's left).
		var lag int64
		if st, err := q.GetAuditDrain(ctx, d.ID); err == nil {
			lag, _ = q.AuditDrainLag(ctx, db.AuditDrainLagParams{LastTxid: st.LastTxid, LastID: st.LastID})
		}
		h.deps.Metrics.Drain(d.ID, sent, failed != nil, lag)
	}
}

// drainPass delivers what's waiting, a batch at a time: how many entries
// it sent, and why it stopped early.
func (h *handlers) drainPass(ctx context.Context, q *db.Queries, d config.AuditDrain) (int, error) {
	sent := 0
	for ctx.Err() == nil {
		st, err := q.GetAuditDrain(ctx, d.ID)
		if err != nil {
			return sent, err
		}
		rows, err := q.AuditLogsAfter(ctx, db.AuditLogsAfterParams{LastTxid: st.LastTxid, LastID: st.LastID, RowLimit: drainBatch})
		if err != nil || len(rows) == 0 {
			return sent, err
		}
		entries := make([]drainEntry, len(rows))
		for i, r := range rows {
			entries[i] = toDrainEntry(r)
		}
		if err := deliver(ctx, d, entries); err != nil {
			return sent, err
		}
		last := rows[len(rows)-1]
		if err := q.AdvanceAuditDrain(ctx, db.AdvanceAuditDrainParams{ID: d.ID, LastTxid: last.Txid, LastID: last.ID}); err != nil {
			return sent, err // sent again next time: at least once
		}
		sent += len(rows)
		if len(rows) < drainBatch {
			break
		}
	}
	return sent, nil
}

var drainHTTP = &http.Client{
	Timeout: 30 * time.Second,
	// A redirect would turn the POST into a GET without the entries, whose
	// 200 would count as delivered: a failure instead (use the final URL).
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// deliver sends one batch: a JSON array POSTed, or JSON lines appended.
func deliver(ctx context.Context, d config.AuditDrain, entries []drainEntry) error {
	switch d.Type {
	case "http":
		body, err := json.Marshal(entries)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.URL, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Supermixer audit drain")
		for k, v := range d.Headers {
			req.Header.Set(k, v)
		}
		// Errors are logged and shown to admins: not the URL's query or
		// user info, which can hold a token.
		where := redactURL(d.URL)
		resp, err := drainHTTP.Do(req)
		if err != nil {
			var ue *url.Error
			if errors.As(err, &ue) {
				err = ue.Err
			}
			return fmt.Errorf("POST %s: %w", where, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode/100 == 3 {
			return fmt.Errorf("%s answered %s (a redirect to %s): set the drain's url to where it goes", where, resp.Status, redactURL(resp.Header.Get("Location")))
		}
		if resp.StatusCode/100 != 2 {
			msg, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
			return fmt.Errorf("%s answered %s: %s", where, resp.Status, bytes.TrimSpace(msg))
		}
		return nil
	case "file":
		var b bytes.Buffer
		enc := json.NewEncoder(&b)
		for _, e := range entries {
			if err := enc.Encode(e); err != nil {
				return err
			}
		}
		f, err := os.OpenFile(d.Path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		if _, err := f.Write(b.Bytes()); err != nil {
			f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			f.Close()
			return err
		}
		return f.Close()
	}
	return fmt.Errorf("unknown drain type %q", d.Type)
}

// drainStatuses says how each drain is doing, for the admin overview.
func (h *handlers) drainStatuses(ctx context.Context) []api.AuditDrainStatus {
	q := h.deps.Store.Queries
	out := []api.AuditDrainStatus{}
	for _, d := range h.deps.Config.Audit.Drains {
		s := api.AuditDrainStatus{Id: d.ID, Type: api.AuditDrainStatusType(d.Type), Target: d.Path}
		if d.Type == "http" {
			s.Target = redactURL(d.URL)
		}
		st, err := q.GetAuditDrain(ctx, d.ID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			s.State = api.AuditDrainStatusStateNotStarted
		case err != nil:
			s.State = api.AuditDrainStatusStateUnknown
		default:
			s.State = api.AuditDrainStatusStateRunning
			s.LastSuccessAt, s.LastError, s.LastErrorAt = st.LastSuccessAt, st.LastError, st.LastErrorAt
			if n, err := q.AuditDrainLag(ctx, db.AuditDrainLagParams{LastTxid: st.LastTxid, LastID: st.LastID}); err == nil {
				s.Pending = &n
			} else {
				s.State = api.AuditDrainStatusStateUnknown
			}
		}
		out = append(out, s)
	}
	return out
}

// redactURL drops what can hold a secret: user info, query and fragment.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "(the drain's URL)"
	}
	u.RawQuery, u.Fragment, u.User = "", "", nil
	return u.String()
}
