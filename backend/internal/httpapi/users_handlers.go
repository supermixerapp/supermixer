package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/store/db"
	"supermixer/internal/version"
)

func toUser(u db.User) api.User {
	return api.User{
		Id: u.ID, Username: u.Username, Email: u.Email, DisplayName: u.DisplayName,
		IsInstanceAdmin: u.IsInstanceAdmin, DefaultPassword: u.DefaultPassword,
		PasswordChangeRequired: u.PasswordChangeRequired, MfaEnabled: hasMFA(u), HasPassword: u.HasPassword, Identities: []string{},
		Disabled: u.DisabledAt != nil, CreatedAt: u.CreatedAt,
	}
}

// notOwnWithToken refuses an admin action on the admin's own account when
// it comes with an access token: the token's limits (tokenRoute) would
// otherwise be side-stepped through the admin API (setting your own
// password or email, signing out your sessions).
func notOwnWithToken(me *principal, target [16]byte) error {
	if me.AccessToken != nil && me.User.ID == target {
		return newError(http.StatusForbidden, "access tokens can't change your own account; sign in to Supermixer for that")
	}
	return nil
}

func requireInstanceAdmin(ctx context.Context) (*principal, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if !p.User.IsInstanceAdmin {
		return nil, newError(http.StatusForbidden, "Only instance admins can manage users")
	}
	return p, nil
}

func (h *handlers) ListUsers(ctx context.Context, _ api.ListUsersRequestObject) (api.ListUsersResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	seen, err := h.deps.Store.Queries.UserLastSeen(ctx)
	if err != nil {
		return nil, err
	}
	activity := map[[16]byte]db.UserLastSeenRow{}
	for _, r := range seen {
		activity[r.UserID] = r
	}
	idents, err := h.deps.Store.Queries.ListAllIdentities(ctx)
	if err != nil {
		return nil, err
	}
	providers := map[[16]byte][]string{}
	for _, r := range idents {
		providers[r.UserID] = append(providers[r.UserID], r.Provider)
	}
	out := make(api.ListUsers200JSONResponse, 0, len(rows))
	for _, u := range rows {
		au := toUser(u)
		if a, ok := activity[u.ID]; ok {
			au.Sessions, au.LastSeenAt = int(a.Sessions), &a.LastSeenAt
		}
		if ps := providers[u.ID]; ps != nil {
			au.Identities = ps
		}
		out = append(out, au)
	}
	return out, nil
}

// newUserParams validates the fields shared by admin-created and
// invitation sign-up accounts.
func newUserParams(username, password string, email *string, displayName string) (db.CreateUserParams, error) {
	var p db.CreateUserParams
	var err error
	if p.Username, err = normalizeUsername(username); err != nil {
		return p, err
	}
	if err := auth.ValidateNewPassword(password, p.Username); err != nil {
		return p, badRequest("%s", err.Error())
	}
	if p.Email, err = normalizeEmail(email); err != nil {
		return p, err
	}
	if p.DisplayName, err = validDisplayName(displayName); err != nil {
		return p, err
	}
	if p.PasswordHash, err = auth.HashPassword(password); err != nil {
		return p, err
	}
	return p, nil
}

func createUserErr(err error) error {
	if isUniqueViolation(err) {
		return conflict("that username or email address is already taken")
	}
	return err
}

func (h *handlers) CreateUser(ctx context.Context, req api.CreateUserRequestObject) (api.CreateUserResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	b := req.Body
	params, err := newUserParams(b.Username, b.Password, b.Email, deref(b.DisplayName))
	if err != nil {
		return nil, err
	}
	params.IsInstanceAdmin = deref(b.IsInstanceAdmin)
	// The admin knows the password they set: the user replaces it, unless
	// the admin says otherwise.
	params.PasswordChangeRequired = b.RequirePasswordChange == nil || *b.RequirePasswordChange
	u, err := h.deps.Store.Queries.CreateUser(ctx, params)
	if err != nil {
		return nil, createUserErr(err)
	}
	h.audit(ctx, nil, auditEntry{Action: "user.created", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"is_instance_admin": u.IsInstanceAdmin, "password_change_required": u.PasswordChangeRequired}})
	return api.CreateUser201JSONResponse(toUser(u)), nil
}

func (h *handlers) loadUser(ctx context.Context, q *db.Queries, id [16]byte) (db.User, error) {
	u, err := q.GetUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, notFound("user")
	}
	return u, err
}

func (h *handlers) UpdateUser(ctx context.Context, req api.UpdateUserRequestObject) (api.UpdateUserResponseObject, error) {
	me, err := requireInstanceAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if err := notOwnWithToken(me, req.UserId); err != nil {
		return nil, err
	}
	b := req.Body
	var updated db.User
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		u, err := h.loadUser(ctx, q, req.UserId)
		if err != nil {
			return err
		}
		self := u.ID == me.User.ID
		if b.DisplayName != nil {
			if u.DisplayName, err = validDisplayName(*b.DisplayName); err != nil {
				return err
			}
		}
		if b.Email != nil {
			if u.Email, err = normalizeEmail(b.Email); err != nil {
				return err
			}
		}
		removingAdmin := b.IsInstanceAdmin != nil && !*b.IsInstanceAdmin && u.IsInstanceAdmin
		disabling := b.Disabled != nil && *b.Disabled && u.DisabledAt == nil
		if self && (removingAdmin || disabling) {
			return badRequest("you cannot disable or demote your own account")
		}
		if (removingAdmin || disabling) && u.IsInstanceAdmin {
			n, err := q.CountActiveInstanceAdmins(ctx)
			if err != nil {
				return err
			}
			if n <= 1 {
				return conflict("Supermixer needs at least one active instance admin")
			}
		}
		if b.IsInstanceAdmin != nil {
			u.IsInstanceAdmin = *b.IsInstanceAdmin
		}
		if b.Disabled != nil {
			if *b.Disabled && u.DisabledAt == nil {
				u.DisabledAt = ptr(time.Now())
			} else if !*b.Disabled {
				u.DisabledAt = nil
			}
		}
		updated, err = q.UpdateUser(ctx, db.UpdateUserParams{
			ID: u.ID, DisplayName: u.DisplayName, Email: u.Email, IsInstanceAdmin: u.IsInstanceAdmin, DisabledAt: u.DisabledAt,
		})
		if err != nil {
			return createUserErr(err)
		}
		if b.PasswordChangeRequired != nil && *b.PasswordChangeRequired != updated.PasswordChangeRequired {
			if self && *b.PasswordChangeRequired {
				return badRequest("change your own password under Account › Preferences")
			}
			if updated, err = q.SetPasswordChangeRequired(ctx, db.SetPasswordChangeRequiredParams{ID: u.ID, PasswordChangeRequired: *b.PasswordChangeRequired}); err != nil {
				return err
			}
		}
		if disabling {
			if err := adviseRotationForUser(ctx, q, u, "disabled"); err != nil {
				return err
			}
			// Deleted, not just hidden: enabling the account again
			// mustn't bring back tokens someone else may have made.
			if err := q.DeleteUserAccessTokens(ctx, u.ID); err != nil {
				return err
			}
			return q.DeleteUserSessions(ctx, u.ID)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.updated", TargetType: "user", TargetID: updated.ID.String(), TargetName: updated.Username,
		Metadata: map[string]any{"is_instance_admin": updated.IsInstanceAdmin, "disabled": updated.DisabledAt != nil,
			"password_change_required": updated.PasswordChangeRequired}})
	return api.UpdateUser200JSONResponse(toUser(updated)), nil
}

func (h *handlers) ResetUserPassword(ctx context.Context, req api.ResetUserPasswordRequestObject) (api.ResetUserPasswordResponseObject, error) {
	me, err := requireInstanceAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if err := notOwnWithToken(me, req.UserId); err != nil {
		return nil, err
	}
	target, err := h.loadUser(ctx, h.deps.Store.Queries, req.UserId)
	if err != nil {
		return nil, err
	}
	if err := auth.ValidateNewPassword(req.Body.Password, target.Username); err != nil {
		return nil, badRequest("%s", err.Error())
	}
	hash, err := auth.HashPassword(req.Body.Password)
	if err != nil {
		return nil, err
	}
	// A password the admin set is temporary, unless they say otherwise (or
	// it's their own).
	change := (req.Body.RequirePasswordChange == nil || *req.Body.RequirePasswordChange) && target.ID != me.User.ID
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if err := q.SetUserPassword(ctx, db.SetUserPasswordParams{ID: target.ID, PasswordHash: hash, PasswordChangeRequired: change}); err != nil {
			return err
		}
		if target.ID == me.User.ID {
			// Keep the admin's own current session.
			return q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: target.ID, ID: me.Session.ID})
		}
		// Someone else may have had the account: their tokens stop too.
		if err := q.DeleteUserAccessTokens(ctx, target.ID); err != nil {
			return err
		}
		return q.DeleteUserSessions(ctx, target.ID)
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.password_reset", TargetType: "user", TargetID: target.ID.String(), TargetName: target.Username,
		Metadata: map[string]any{"password_change_required": change}})
	if target.ID != me.User.ID {
		h.notify(ctx, target, "Your Supermixer password was reset", fmt.Sprintf("An instance admin (%s) set a new password", me.User.Username))
	}
	return api.ResetUserPassword204Response{}, nil
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

func (h *handlers) RevokeUserSessions(ctx context.Context, req api.RevokeUserSessionsRequestObject) (api.RevokeUserSessionsResponseObject, error) {
	me, err := requireInstanceAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if err := notOwnWithToken(me, req.UserId); err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	target, err := h.loadUser(ctx, q, req.UserId)
	if err != nil {
		return nil, err
	}
	if target.ID == me.User.ID { // keep the session this request came from
		err = q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: target.ID, ID: me.Session.ID})
	} else if err = q.DeleteUserAccessTokens(ctx, target.ID); err == nil {
		// Signed out everywhere includes scripts using their tokens.
		err = q.DeleteUserSessions(ctx, target.ID)
	}
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.signed_out_everywhere", TargetType: "user", TargetID: target.ID.String(), TargetName: target.Username})
	return api.RevokeUserSessions204Response{}, nil
}

func (h *handlers) GetAdminOverview(ctx context.Context, _ api.GetAdminOverviewRequestObject) (api.GetAdminOverviewResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	c, err := h.deps.Store.Queries.InstanceCounts(ctx)
	if err != nil {
		return nil, err
	}
	pv := h.deps.Config.Provisioning
	out := api.GetAdminOverview200JSONResponse{
		Version: version.Version, Users: int(c.Users), ActiveUsers: int(c.ActiveUsers), InstanceAdmins: int(c.InstanceAdmins),
		PasswordChangeRequired: int(c.PasswordChangeRequired), MfaEnabled: int(c.MfaEnabled), Organizations: int(c.Organizations),
		Projects: int(c.Projects), ManagedProjects: int(c.ManagedProjects),
	}
	out.Provisioning.Enabled, out.Provisioning.StacksDir, out.Provisioning.PublicHost = pv.Enabled, pv.StacksDir, pv.PublicHost
	out.Backups.Dir, out.Backups.IntervalHours, out.Backups.Keep = pv.BackupsDir, float32(pv.BackupInterval.Hours()), pv.BackupKeep
	if h.s3 != nil {
		loc := "s3://" + path.Join(h.s3.Bucket(), pv.BackupS3.Prefix)
		out.Backups.S3 = &loc
	}
	out.Sso = make([]struct {
		AllowedDomains []string `json:"allowed_domains"`
		CreateUsers    bool     `json:"create_users"`
		Id             string   `json:"id"`
		Issuer         string   `json:"issuer"`
		Name           string   `json:"name"`
		RedirectUri    string   `json:"redirect_uri"`
	}, 0)
	for _, p := range h.deps.Config.SSO.Providers {
		d := p.AllowedDomains
		if d == nil {
			d = []string{}
		}
		out.Sso = append(out.Sso, struct {
			AllowedDomains []string `json:"allowed_domains"`
			CreateUsers    bool     `json:"create_users"`
			Id             string   `json:"id"`
			Issuer         string   `json:"issuer"`
			Name           string   `json:"name"`
			RedirectUri    string   `json:"redirect_uri"`
		}{d, p.CreateUsers, p.ID, p.Issuer, p.Name, h.joinURL("/api/v1/auth/sso/"+p.ID+"/callback", nil)})
	}
	if h.mailer != nil {
		e := h.deps.Config.Email
		from := h.mailer.From()
		server := fmt.Sprintf("%s:%d (%s)", e.SMTPHost, e.SMTPPort, map[string]string{"starttls": "STARTTLS", "tls": "TLS", "none": "unencrypted"}[e.Security])
		out.Email.Enabled, out.Email.From, out.Email.Server = true, &from, &server
	}
	if l := h.deps.Config.Metrics.Listen; l != "" {
		out.MetricsListen = &l
	}
	out.AuditDrains = h.drainStatuses(ctx)
	return out, nil
}

func (h *handlers) ListInstanceAuditLogs(ctx context.Context, req api.ListInstanceAuditLogsRequestObject) (api.ListInstanceAuditLogsResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	limit := 50
	if req.Params.Limit != nil {
		limit = min(max(*req.Params.Limit, 1), 200)
	}
	params := db.ListInstanceAuditLogsParams{BeforeID: req.Params.Before, RowLimit: int32(limit + 1)}
	if s := strings.TrimSpace(deref(req.Params.Action)); s != "" {
		params.ActionPrefix = &s
	}
	rows, err := h.deps.Store.Queries.ListInstanceAuditLogs(ctx, params)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return api.ListInstanceAuditLogs200JSONResponse(toAuditPage(rows, limit)), nil
}
