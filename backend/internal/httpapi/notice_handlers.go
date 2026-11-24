package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/store/db"
)

// The instance-wide notice (Instance › Global notice): one at a time, kept
// in instance_settings and shown to everyone signed in, above the header.

const (
	noticeKey        = "global_notice"
	maxNoticeMessage = 256
)

var noticeTypes = []api.NoticeType{api.NoticeTypeInfo, api.NoticeTypeWarning, api.NoticeTypeCritical}

// storedNotice is the notice as kept in instance_settings; its time is the
// row's updated_at.
type storedNotice struct {
	Type     api.NoticeType `json:"type"`
	Message  string         `json:"message"`
	PostedBy string         `json:"posted_by"`
}

// noticeLink is a Markdown link, as the web app reads it (notice-markdown.ts).
var noticeLink = regexp.MustCompile(`\[([^\]\n]+)\]\(([^)\s]+)\)`)

// checkNoticeLinks refuses links the band wouldn't follow: only http(s)
// and mailto: URLs, and paths in Supermixer.
func checkNoticeLinks(message string) error {
	for _, m := range noticeLink.FindAllStringSubmatch(message, -1) {
		href := m[2]
		if strings.HasPrefix(href, "/") && !strings.HasPrefix(href, "//") && !strings.HasPrefix(href, "/\\") {
			continue
		}
		u, err := url.Parse(href)
		if err == nil && (u.Scheme == "mailto" || (u.Scheme == "http" || u.Scheme == "https") && u.Host != "") {
			continue
		}
		return badRequest("the link to %q can't be used; links go to https://, http://, mailto: or a path here such as /account/security", href)
	}
	return nil
}

// normalizeNotice is the message as shown: one line, without spare spaces.
func normalizeNotice(message string) string {
	return strings.Join(strings.Fields(message), " ")
}

func (h *handlers) currentNotice(ctx context.Context) (*api.GlobalNotice, error) {
	row, err := h.deps.Store.Queries.GetInstanceSetting(ctx, noticeKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	var n storedNotice
	if err := json.Unmarshal(row.Value, &n); err != nil {
		return nil, err
	}
	return &api.GlobalNotice{Type: n.Type, Message: n.Message, PostedBy: n.PostedBy, PostedAt: row.UpdatedAt}, nil
}

func (h *handlers) GetNotice(ctx context.Context, _ api.GetNoticeRequestObject) (api.GetNoticeResponseObject, error) {
	n, err := h.currentNotice(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetNotice200JSONResponse{Notice: n}, nil
}

func (h *handlers) SetNotice(ctx context.Context, req api.SetNoticeRequestObject) (api.SetNoticeResponseObject, error) {
	me, err := requireInstanceAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(noticeTypes, req.Body.Type) {
		return nil, badRequest("the notice type must be info, warning or critical")
	}
	message := normalizeNotice(req.Body.Message)
	if message == "" {
		return nil, badRequest("write a message")
	}
	if n := utf8.RuneCountInString(message); n > maxNoticeMessage {
		return nil, badRequest("the message is %d characters; the most is %d", n, maxNoticeMessage)
	}
	if err := checkNoticeLinks(message); err != nil {
		return nil, err
	}
	value, err := json.Marshal(storedNotice{Type: req.Body.Type, Message: message, PostedBy: me.User.Username})
	if err != nil {
		return nil, err
	}
	if err := h.deps.Store.Queries.SetInstanceSetting(ctx, db.SetInstanceSettingParams{Key: noticeKey, Value: value}); err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "instance.notice_posted", TargetType: "instance", TargetName: "Global notice",
		Metadata: map[string]any{"type": req.Body.Type, "message": message}})
	n, err := h.currentNotice(ctx)
	if err != nil {
		return nil, err
	}
	return api.SetNotice200JSONResponse(*n), nil
}

func (h *handlers) DeleteNotice(ctx context.Context, _ api.DeleteNoticeRequestObject) (api.DeleteNoticeResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	n, err := h.deps.Store.Queries.DeleteInstanceSetting(ctx, noticeKey)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		h.audit(ctx, nil, auditEntry{Action: "instance.notice_removed", TargetType: "instance", TargetName: "Global notice"})
	}
	return api.DeleteNotice204Response{}, nil
}
