package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/store/db"
)

// "Forgot your password?" (Stage 5.3): a link by email that works once, for
// an hour. Accounts with two-factor sign-in need a code as well, so the
// email account alone isn't enough to take them over.

const passwordResetTTL = time.Hour

func (h *handlers) RequestPasswordReset(ctx context.Context, req api.RequestPasswordResetRequestObject) (api.RequestPasswordResetResponseObject, error) {
	login := strings.ToLower(strings.TrimSpace(req.Body.Login))
	if login == "" {
		return nil, badRequest("enter your username or email address")
	}
	if h.mailer == nil {
		return nil, conflict("Supermixer can't send email here; ask an instance admin to reset your password")
	}
	// Every request counts (none "succeeds"), per address.
	if err := h.attempt("password reset requests", "reset-ip:"+reqInfo(ctx).IP); err != nil {
		return nil, err
	}
	// The rest happens after answering, so how long the answer takes
	// doesn't tell whether there's such an account.
	info := *reqInfo(ctx)
	info.Principal = nil
	h.pending.Add(1)
	go func() {
		defer h.pending.Done()
		bg, cancel := context.WithTimeout(withRequestInfo(context.Background(), &info), time.Minute)
		defer cancel()
		if err := h.sendResetLink(bg, login); err != nil {
			h.deps.Logger.Warn("password reset link", "err", err)
		}
	}()
	return api.RequestPasswordReset202Response{}, nil
}

// sendResetLink emails a reset link to the account login names, if it's an
// active account with an email address that hasn't had too many lately.
func (h *handlers) sendResetLink(ctx context.Context, login string) error {
	q := h.deps.Store.Queries
	var u db.User
	var err error
	if strings.Contains(login, "@") {
		u, err = q.GetUserByEmail(ctx, login)
	} else {
		u, err = q.GetUserByUsername(ctx, login)
	}
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (u.DisabledAt != nil || u.Email == nil)) {
		return nil
	} else if err != nil {
		return err
	}
	// A few links an hour per account, however it's named: others asking
	// can't fill its inbox.
	if ok, _ := h.resetMail.Attempt(u.ID.String()); !ok {
		h.deps.Logger.Info("password reset link not sent: too many for this account lately", "user", u.Username)
		return nil
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	ip := reqInfo(ctx).IP
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if err := q.DeletePasswordResets(ctx, u.ID); err != nil {
			return err
		}
		_, err := q.CreatePasswordReset(ctx, db.CreatePasswordResetParams{
			UserID: u.ID, TokenHash: hash, Ip: ip, ExpiresAt: time.Now().Add(passwordResetTTL),
		})
		return err
	})
	if err != nil {
		return err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.password_reset_requested", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username})
	return h.sendEmail(ctx, *u.Email, "Reset your Supermixer password", emailContent{
		Heading: "Reset your password",
		Intro: []string{
			fmt.Sprintf("Someone, hopefully you, asked to reset the password of %s on Supermixer at %s.", u.Username, h.host()),
			"Choose a new password with this link. It works once, for an hour.",
		},
		Button: "Choose a new password",
		Link:   h.joinURL("/reset-password", url.Values{"token": {token}}),
		Outro: []string{
			fmt.Sprintf("Asked for from %s. If it wasn't you, ignore this email: your password stays as it is.", ip),
		},
	})
}

var errResetGone = newError(http.StatusGone, "This link has expired or was already used; ask for a new one")

// passwordReset finds the user a working reset link is for.
func (h *handlers) passwordReset(ctx context.Context, token string) (db.PasswordReset, db.User, error) {
	q := h.deps.Store.Queries
	r, err := q.GetPasswordReset(ctx, auth.HashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return r, db.User{}, errResetGone
	} else if err != nil {
		return r, db.User{}, err
	}
	u, err := q.GetUserByID(ctx, r.UserID)
	if err != nil {
		return r, u, err
	}
	if u.DisabledAt != nil {
		return r, u, errResetGone
	}
	return r, u, nil
}

func (h *handlers) GetPasswordReset(ctx context.Context, req api.GetPasswordResetRequestObject) (api.GetPasswordResetResponseObject, error) {
	r, u, err := h.passwordReset(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	return api.GetPasswordReset200JSONResponse{Username: u.Username, MfaRequired: hasMFA(u), ExpiresAt: r.ExpiresAt}, nil
}

func (h *handlers) CompletePasswordReset(ctx context.Context, req api.CompletePasswordResetRequestObject) (api.CompletePasswordResetResponseObject, error) {
	ipKey := "reset-complete-ip:" + reqInfo(ctx).IP
	if err := h.attempt("attempts", ipKey); err != nil {
		return nil, err
	}
	r, u, err := h.passwordReset(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	if err := auth.ValidateNewPassword(req.Body.Password, u.Username); err != nil {
		return nil, badRequest("%s", err.Error())
	}
	if hasMFA(u) && deref(req.Body.Code) == "" {
		return nil, badRequest("enter a code from your authenticator app, or a recovery code")
	}
	hash, err := auth.HashPassword(req.Body.Password)
	if err != nil {
		return nil, err
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if _, err := q.UsePasswordReset(ctx, r.ID); errors.Is(err, pgx.ErrNoRows) {
			return errResetGone
		} else if err != nil {
			return err
		}
		// In the same transaction: a code is only spent if the password
		// changes, and a wrong one leaves the link working.
		if hasMFA(u) {
			if _, err := h.checkCode(ctx, q, u, deref(req.Body.Code)); err != nil {
				return codeError(err, http.StatusBadRequest)
			}
		}
		if err := q.SetUserPassword(ctx, db.SetUserPasswordParams{ID: u.ID, PasswordHash: hash}); err != nil {
			return err
		}
		if err := q.DeletePasswordResets(ctx, u.ID); err != nil {
			return err
		}
		// Whoever knew the old password is signed out too, and their
		// tokens stop working.
		if err := q.DeleteUserAccessTokens(ctx, u.ID); err != nil {
			return err
		}
		return q.DeleteUserSessions(ctx, u.ID)
	})
	if err != nil {
		return nil, err
	}
	h.limiter.Reset(ipKey)
	h.limiter.Reset("user:" + u.Username)
	h.audit(ctx, nil, auditEntry{Action: "user.password_reset_by_email", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username})
	h.notify(ctx, u, "Your Supermixer password was changed", "Your password was changed with a reset link, and every session was signed out,")
	return api.CompletePasswordReset204Response{}, nil
}

func (h *handlers) SendTestEmail(ctx context.Context, _ api.SendTestEmailRequestObject) (api.SendTestEmailResponseObject, error) {
	me, err := requireInstanceAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if h.mailer == nil {
		return nil, conflict("email is off; set email.smtp_host in the server's configuration")
	}
	if me.User.Email == nil {
		return nil, badRequest("add an email address to your account (Account › Preferences) to send yourself a test")
	}
	err = h.sendEmail(ctx, *me.User.Email, "Supermixer email works", emailContent{
		Heading: "Email works",
		Intro: []string{
			fmt.Sprintf("This is a test from Supermixer at %s, sent by %s. Invitations, password-reset links and security notices will arrive like this one.", h.host(), me.User.Username),
		},
	})
	if err != nil {
		return nil, newError(http.StatusBadGateway, "the mail server didn't take it: %s", err.Error())
	}
	h.audit(ctx, nil, auditEntry{Action: "instance.test_email_sent", TargetType: "user", TargetID: me.User.ID.String(), TargetName: me.User.Username})
	return api.SendTestEmail200JSONResponse{SentTo: *me.User.Email}, nil
}
