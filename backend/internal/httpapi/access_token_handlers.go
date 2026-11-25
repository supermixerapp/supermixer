package httpapi

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/store/db"
)

// Personal access tokens: for scripts and CI, in
// Authorization: Bearer sbp_…. A token acts as its owner, except that it
// can't change how the account is secured (see tokenRoute).

const maxAccessTokens = 50

func toAccessToken(t db.AccessToken) api.AccessToken {
	out := api.AccessToken{Id: t.ID, Name: t.Name, Prefix: t.Prefix, CreatedAt: t.CreatedAt, ExpiresAt: t.ExpiresAt, LastUsedAt: t.LastUsedAt}
	if t.LastUsedIp != "" {
		out.LastUsedIp = &t.LastUsedIp
	}
	return out
}

func (h *handlers) ListAccessTokens(ctx context.Context, _ api.ListAccessTokensRequestObject) (api.ListAccessTokensResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListAccessTokens(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListAccessTokens200JSONResponse, len(rows))
	for i, t := range rows {
		out[i] = toAccessToken(t)
	}
	return out, nil
}

func (h *handlers) CreateAccessToken(ctx context.Context, req api.CreateAccessTokenRequestObject) (api.CreateAccessTokenResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.Body.Name)
	if name == "" || len([]rune(name)) > 64 {
		return nil, badRequest("name the token (1–64 characters), after what will use it")
	}
	days := req.Body.ExpiresInDays
	if days < 1 || days > 365 {
		return nil, badRequest("a token lasts 1–365 days")
	}
	token, hash, shown, err := auth.NewAccessToken()
	if err != nil {
		return nil, err
	}
	var t db.AccessToken
	// Counted and added under a lock on the user, so parallel requests
	// can't pass the limit.
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if err := q.LockUser(ctx, p.User.ID); err != nil {
			return err
		}
		if n, err := q.CountUserAccessTokens(ctx, p.User.ID); err != nil {
			return err
		} else if n >= maxAccessTokens {
			return conflict("you have %d tokens; revoke some first", n)
		}
		t, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{
			UserID: p.User.ID, Name: name, TokenHash: hash, Prefix: shown, ExpiresAt: time.Now().AddDate(0, 0, days),
			// As the session that made it signed in (organizations requiring SSO).
			SsoProvider: p.Session.SsoProvider,
		})
		return err
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.access_token_created", TargetType: "access_token", TargetID: t.ID.String(), TargetName: name,
		Metadata: map[string]any{"prefix": shown, "expires_at": t.ExpiresAt}})
	h.notify(ctx, p.User, "A Supermixer access token was created", "An access token named “"+name+"” ("+shown+"…) was created")
	base := toAccessToken(t)
	return api.CreateAccessToken201JSONResponse{
		Id: base.Id, Name: base.Name, Prefix: base.Prefix, CreatedAt: base.CreatedAt, ExpiresAt: base.ExpiresAt, Token: token,
	}, nil
}

func (h *handlers) DeleteAccessToken(ctx context.Context, req api.DeleteAccessTokenRequestObject) (api.DeleteAccessTokenResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	t, err := h.deps.Store.Queries.DeleteAccessToken(ctx, db.DeleteAccessTokenParams{ID: req.TokenId, UserID: p.User.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, notFound("access token")
	} else if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.access_token_revoked", TargetType: "access_token", TargetID: t.ID.String(), TargetName: t.Name,
		Metadata: map[string]any{"prefix": t.Prefix}})
	return api.DeleteAccessToken204Response{}, nil
}
