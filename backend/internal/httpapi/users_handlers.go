package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/store/db"
)

func toUser(u db.User) api.User {
	return api.User{
		Id: u.ID, Username: u.Username, Email: u.Email, DisplayName: u.DisplayName,
		IsInstanceAdmin: u.IsInstanceAdmin, DefaultPassword: u.DefaultPassword,
		Disabled: u.DisabledAt != nil, CreatedAt: u.CreatedAt,
	}
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
	out := make(api.ListUsers200JSONResponse, 0, len(rows))
	for _, u := range rows {
		out = append(out, toUser(u))
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
	if err := auth.ValidateNewPassword(password); err != nil {
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
	u, err := h.deps.Store.Queries.CreateUser(ctx, params)
	if err != nil {
		return nil, createUserErr(err)
	}
	h.audit(ctx, nil, auditEntry{Action: "user.created", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"is_instance_admin": u.IsInstanceAdmin}})
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
		if disabling {
			if err := adviseRotationForUser(ctx, q, u, "disabled"); err != nil {
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
		Metadata: map[string]any{"is_instance_admin": updated.IsInstanceAdmin, "disabled": updated.DisabledAt != nil}})
	return api.UpdateUser200JSONResponse(toUser(updated)), nil
}

func (h *handlers) ResetUserPassword(ctx context.Context, req api.ResetUserPasswordRequestObject) (api.ResetUserPasswordResponseObject, error) {
	me, err := requireInstanceAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if err := auth.ValidateNewPassword(req.Body.Password); err != nil {
		return nil, badRequest("%s", err.Error())
	}
	hash, err := auth.HashPassword(req.Body.Password)
	if err != nil {
		return nil, err
	}
	var target db.User
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if target, err = h.loadUser(ctx, q, req.UserId); err != nil {
			return err
		}
		if err := q.SetUserPassword(ctx, db.SetUserPasswordParams{ID: target.ID, PasswordHash: hash}); err != nil {
			return err
		}
		if target.ID == me.User.ID {
			// Keep the admin's own current session.
			return q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: target.ID, ID: me.Session.ID})
		}
		return q.DeleteUserSessions(ctx, target.ID)
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.password_reset", TargetType: "user", TargetID: target.ID.String(), TargetName: target.Username})
	return api.ResetUserPassword204Response{}, nil
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}
