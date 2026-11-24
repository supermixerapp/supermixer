package httpapi

import (
	"context"
	"encoding/json"
	"strings"

	"supermixer/internal/api"
	"supermixer/internal/store/db"
)

// ListMyAuditLogs is Account › Audit log: what you did, and what was done
// to your account.
func (h *handlers) ListMyAuditLogs(ctx context.Context, req api.ListMyAuditLogsRequestObject) (api.ListMyAuditLogsResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	limit := 50
	if req.Params.Limit != nil {
		limit = min(max(*req.Params.Limit, 1), 200)
	}
	params := db.ListUserAuditLogsParams{UserID: p.User.ID, BeforeID: req.Params.Before, RowLimit: int32(limit + 1)}
	if s := strings.TrimSpace(deref(req.Params.Action)); s != "" {
		params.ActionPrefix = &s
	}
	rows, err := h.deps.Store.Queries.ListUserAuditLogs(ctx, params)
	if err != nil {
		return nil, err
	}
	page := api.AuditLogPage{Entries: []api.AuditLogEntry{}}
	if len(rows) > limit {
		rows = rows[:limit]
		page.NextBefore = ptr(rows[len(rows)-1].ID)
	}
	for _, r := range rows {
		e := api.AuditLogEntry{
			Id: r.ID, Action: r.Action, ActorId: r.ActorID, ActorUsername: r.ActorUsername,
			TargetType: r.TargetType, TargetId: r.TargetID, TargetName: r.TargetName,
			CreatedAt: r.CreatedAt, Metadata: map[string]any{}, OrganizationSlug: r.OrganizationSlug,
		}
		// Someone else's IP address isn't yours to see.
		if r.ActorID != nil && *r.ActorID == p.User.ID {
			e.Ip = r.Ip
		}
		_ = json.Unmarshal(r.Metadata, &e.Metadata)
		if r.TargetType == "project" {
			e.ProjectRef = ptr(r.TargetID)
		}
		page.Entries = append(page.Entries, e)
	}
	return api.ListMyAuditLogs200JSONResponse(page), nil
}
