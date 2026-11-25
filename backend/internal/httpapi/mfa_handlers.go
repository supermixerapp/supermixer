package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/store/db"
)

// Two-factor sign-in: an authenticator app's codes (TOTP) and
// single-use recovery codes. Signing in takes the password, then a code:
// the password step returns a short-lived challenge, sealed with the
// instance key, and only a right code turns it into a session.

const (
	// mfaCookie carries the challenge after single sign-on.
	mfaCookie         = "sm_mfa"
	mfaChallengeTTL   = 5 * time.Minute
	recoveryCodeCount = 10
)

type mfaChallenge struct {
	// ID makes each challenge single-use (mfa_used_challenges).
	ID      uuid.UUID `json:"i"`
	UserID  uuid.UUID `json:"u"`
	Expires int64     `json:"e"`
	// Password is a fingerprint of the password hash: a challenge stops
	// working when the password changes.
	Password []byte `json:"p"`
	// SSO is the provider when single sign-on came first, and Email the
	// address it vouched for (for joining organizations).
	SSO   string `json:"s,omitempty"`
	Email string `json:"m,omitempty"`
}

var challengeAD = []byte("supermixer mfa challenge")

func passwordFingerprint(hash string) []byte {
	sum := sha256.Sum256([]byte(hash))
	return sum[:8]
}

func totpAD(id uuid.UUID) []byte { return []byte("totp:" + id.String()) }

func hasMFA(u db.User) bool { return u.MfaEnabledAt != nil }

// mfaRequired is the error for an organization that requires two-factor
// sign-in, which the caller hasn't turned on.
func mfaRequired(org string) error {
	return &apiError{status: http.StatusForbidden, code: "mfa_required",
		message: "“" + org + "” requires two-factor sign-in; turn it on under Account › Security to continue"}
}

func (h *handlers) newMFAChallenge(u db.User, sso, email string) (api.MfaChallenge, error) {
	exp := time.Now().Add(mfaChallengeTTL).UTC().Truncate(time.Second)
	sealed, err := h.deps.Box.SealJSON(mfaChallenge{ID: uuid.New(), UserID: u.ID, Expires: exp.Unix(),
		Password: passwordFingerprint(u.PasswordHash), SSO: sso, Email: email}, challengeAD)
	if err != nil {
		return api.MfaChallenge{}, err
	}
	return api.MfaChallenge{MfaRequired: true, Challenge: base64.RawURLEncoding.EncodeToString(sealed), ExpiresAt: exp}, nil
}

var errWrongCode = errors.New("that code isn't right, or it was already used")

// checkCode accepts a code from the user's app, or one of their recovery
// codes, once. Codes have their own lockout per user (separate from the
// password's): sign-in.max_failures tries per window until one is right.
// It returns how they proved it: "totp" or "recovery_code".
func (h *handlers) checkCode(ctx context.Context, q *db.Queries, u db.User, code string) (string, error) {
	key := mfaKey(u.ID)
	if err := h.attempt("codes tried", key); err != nil {
		return "", err
	}
	method, ok, err := h.matchCode(ctx, q, u, code)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errWrongCode
	}
	h.limiter.Reset(key)
	return method, nil
}

func mfaKey(id uuid.UUID) string { return "mfa:" + id.String() }

func (h *handlers) matchCode(ctx context.Context, q *db.Queries, u db.User, code string) (string, bool, error) {
	if auth.LooksLikeTOTP(code) {
		if u.TotpSecret == nil {
			return "", false, nil
		}
		secret, err := h.deps.Box.Open(u.TotpSecret, totpAD(u.ID))
		if err != nil {
			return "", false, err
		}
		step, ok := auth.VerifyTOTP(secret, code, time.Now())
		if !ok {
			return "", false, nil
		}
		// Each code works once, and never one older than the last used.
		if _, err := q.UseTOTPStep(ctx, db.UseTOTPStepParams{ID: u.ID, TotpLastStep: &step}); errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		} else if err != nil {
			return "", false, err
		}
		return "totp", true, nil
	}
	if _, err := q.UseRecoveryCode(ctx, db.UseRecoveryCodeParams{UserID: u.ID, CodeHash: auth.HashRecoveryCode(code)}); errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	} else if err != nil {
		return "", false, err
	}
	return "recovery_code", true, nil
}

// codeError turns a wrong code into a response with the given status.
func codeError(err error, status int) error {
	if errors.Is(err, errWrongCode) {
		return newError(status, "%s", err.Error())
	}
	return err
}

func (h *handlers) VerifyMfa(ctx context.Context, req api.VerifyMfaRequestObject) (api.VerifyMfaResponseObject, error) {
	again := newError(http.StatusUnauthorized, "Your sign-in expired; enter your password again")
	challenge := deref(req.Body.Challenge)
	if challenge == "" {
		challenge = reqInfo(ctx).MFAChallenge // after single sign-on
	}
	raw, err := base64.RawURLEncoding.DecodeString(challenge)
	if err != nil {
		return nil, again
	}
	var c mfaChallenge
	if err := h.deps.Box.OpenJSON(raw, challengeAD, &c); err != nil || time.Now().Unix() > c.Expires {
		return nil, again
	}
	ipKey := "ip:" + reqInfo(ctx).IP
	if err := h.attempt("sign-in attempts", ipKey); err != nil {
		return nil, err
	}
	q := h.deps.Store.Queries
	u, err := q.GetUserByID(ctx, c.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, again
	} else if err != nil {
		return nil, err
	}
	if u.DisabledAt != nil || !hasMFA(u) || string(passwordFingerprint(u.PasswordHash)) != string(c.Password) {
		return nil, again
	}
	// Refuse a used challenge before spending a code on it (UseChallenge
	// below settles races).
	if used, err := q.ChallengeUsed(ctx, c.ID); err != nil {
		return nil, err
	} else if used {
		return nil, again
	}
	method, err := h.checkCode(ctx, q, u, req.Body.Code)
	if err != nil {
		if errors.Is(err, errWrongCode) {
			h.deps.Metrics.SignIn("mfa", false)
			reqInfo(ctx).Principal = &principal{User: u}
			h.audit(ctx, nil, auditEntry{Action: "user.mfa_failed", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username})
		}
		return nil, codeError(err, http.StatusUnauthorized)
	}
	// A challenge makes one session; reusing it means the password again.
	_ = q.PruneUsedChallenges(ctx)
	if _, err := q.UseChallenge(ctx, db.UseChallengeParams{ID: c.ID, ExpiresAt: time.Unix(c.Expires, 0)}); errors.Is(err, pgx.ErrNoRows) {
		return nil, again
	} else if err != nil {
		return nil, err
	}
	h.limiter.Reset(ipKey)
	h.deps.Metrics.SignIn("mfa", true)
	cookies, err := h.startSession(ctx, q, u.ID, c.SSO)
	if err != nil {
		return nil, err
	}
	reqInfo(ctx).Principal = &principal{User: u}
	h.audit(ctx, nil, auditEntry{Action: "user.signed_in", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"mfa": method}})
	if c.SSO != "" { // single sign-on came first
		h.ssoAutoJoin(ctx, u, c.SSO, c.Email)
	}
	cookies = append(cookies, &http.Cookie{Name: mfaCookie, Value: "", Path: "/api/v1/auth/mfa", MaxAge: -1, HttpOnly: true})
	return verifyMfaResponse{withCookies{status: http.StatusOK, body: toProfile(u), cookies: cookies}}, nil
}

type verifyMfaResponse struct{ withCookies }

func (r verifyMfaResponse) VisitVerifyMfaResponse(w http.ResponseWriter) error { return r.visit(w) }

func (h *handlers) GetMfaStatus(ctx context.Context, _ api.GetMfaStatusRequestObject) (api.GetMfaStatusResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	left, err := h.deps.Store.Queries.CountRecoveryCodesLeft(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	return api.GetMfaStatus200JSONResponse{Enabled: hasMFA(p.User), EnabledAt: p.User.MfaEnabledAt, RecoveryCodesLeft: int(left)}, nil
}

// confirmPassword checks the signed-in user's password before a security
// change, counting wrong ones towards the sign-in lockout. An account
// without a password (made through single sign-on) confirms by having
// signed in recently instead.
func (h *handlers) confirmPassword(p *principal, password string) error {
	u := p.User
	if !u.HasPassword {
		if time.Since(p.Session.CreatedAt) > freshSignIn {
			return newError(http.StatusForbidden, "to confirm it's you, sign out and sign in again, then do this within %d minutes", int(freshSignIn.Minutes()))
		}
		return nil
	}
	key := "user:" + u.Username
	if err := h.attempt("password attempts", key); err != nil {
		return err
	}
	if auth.VerifyPassword(u.PasswordHash, password) != nil {
		return badRequest("your password isn't right")
	}
	h.limiter.Reset(key)
	return nil
}

// freshSignIn is how recent a sign-in confirms it's you, for accounts
// without a password.
const freshSignIn = 15 * time.Minute

func (h *handlers) SetupMfa(ctx context.Context, req api.SetupMfaRequestObject) (api.SetupMfaResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if hasMFA(p.User) {
		return nil, conflict("two-factor sign-in is already on; turn it off first to use another app")
	}
	if err := h.confirmPassword(p, req.Body.Password); err != nil {
		return nil, err
	}
	secret, err := auth.NewTOTPSecret()
	if err != nil {
		return nil, err
	}
	sealed, err := h.deps.Box.Seal(secret, totpAD(p.User.ID))
	if err != nil {
		return nil, err
	}
	if err := h.deps.Store.Queries.SetTOTPPending(ctx, db.SetTOTPPendingParams{ID: p.User.ID, TotpPending: sealed}); err != nil {
		return nil, err
	}
	// The account name shows in the app; the host tells instances apart.
	account := p.User.Username
	if u, err := url.Parse(h.deps.Config.Server.PublicURL); err == nil && u.Hostname() != "" {
		account += "@" + u.Hostname()
	}
	uri := auth.TOTPURI(secret, "Supermixer", account)
	svg, err := auth.QRSVG(uri)
	if err != nil {
		return nil, err
	}
	return api.SetupMfa200JSONResponse{Secret: auth.TOTPSecretText(secret), Uri: uri, QrSvg: svg}, nil
}

// newRecoveryCodes replaces the user's recovery codes.
func newRecoveryCodes(ctx context.Context, q *db.Queries, userID uuid.UUID) ([]string, error) {
	codes, err := auth.NewRecoveryCodes(recoveryCodeCount)
	if err != nil {
		return nil, err
	}
	if err := q.DeleteRecoveryCodes(ctx, userID); err != nil {
		return nil, err
	}
	for _, c := range codes {
		if err := q.AddRecoveryCode(ctx, db.AddRecoveryCodeParams{UserID: userID, CodeHash: auth.HashRecoveryCode(c)}); err != nil {
			return nil, err
		}
	}
	return codes, nil
}

func (h *handlers) EnableMfa(ctx context.Context, req api.EnableMfaRequestObject) (api.EnableMfaResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	u := p.User
	if hasMFA(u) {
		return nil, conflict("two-factor sign-in is already on")
	}
	if u.TotpPending == nil {
		return nil, badRequest("start setting up the app again")
	}
	key := mfaKey(u.ID)
	if err := h.attempt("codes tried", key); err != nil {
		return nil, err
	}
	secret, err := h.deps.Box.Open(u.TotpPending, totpAD(u.ID))
	if err != nil {
		return nil, err
	}
	step, ok := auth.VerifyTOTP(secret, req.Body.Code, time.Now())
	if !ok {
		return nil, badRequest("that code isn't right; check the app shows Supermixer and your device's clock is right")
	}
	h.limiter.Reset(key)
	var codes []string
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if _, err := q.EnableTOTP(ctx, db.EnableTOTPParams{ID: u.ID, TotpLastStep: &step}); errors.Is(err, pgx.ErrNoRows) {
			return conflict("two-factor sign-in changed meanwhile; reload and try again")
		} else if err != nil {
			return err
		}
		if codes, err = newRecoveryCodes(ctx, q, u.ID); err != nil {
			return err
		}
		// Sessions opened with the password alone (perhaps someone else's,
		// with a leaked password) would otherwise count as two-factor ones
		// from now on; so would tokens made with them.
		if err := q.DeleteUserAccessTokens(ctx, u.ID); err != nil {
			return err
		}
		return q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: u.ID, ID: p.Session.ID})
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.mfa_enabled", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"other_sessions_signed_out": true}})
	h.notify(ctx, u, "Two-factor sign-in was turned on", "Two-factor sign-in was turned on, your other sessions were signed out and your access tokens revoked,")
	return api.EnableMfa200JSONResponse{Codes: codes}, nil
}

func (h *handlers) DisableMfa(ctx context.Context, req api.DisableMfaRequestObject) (api.DisableMfaResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	u := p.User
	if !hasMFA(u) {
		return nil, conflict("two-factor sign-in is already off")
	}
	if err := h.confirmPassword(p, req.Body.Password); err != nil {
		return nil, err
	}
	// Then the password is the only way in: it needs 15 characters.
	if u.HasPassword && auth.PasswordLength(req.Body.Password) < auth.MinSingleFactorPasswordLength {
		return nil, conflict("without two-factor sign-in, a password needs at least %d characters: change yours under Account › Preferences first", auth.MinSingleFactorPasswordLength)
	}
	q := h.deps.Store.Queries
	method, err := h.checkCode(ctx, q, u, req.Body.Code)
	if err != nil {
		return nil, codeError(err, http.StatusBadRequest)
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if err := q.DisableMFA(ctx, u.ID); err != nil {
			return err
		}
		return q.DeleteRecoveryCodes(ctx, u.ID)
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.mfa_disabled", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"confirmed_with": method}})
	h.notify(ctx, u, "Two-factor sign-in was turned off", "Two-factor sign-in was turned off")
	return api.DisableMfa204Response{}, nil
}

func (h *handlers) RegenerateRecoveryCodes(ctx context.Context, req api.RegenerateRecoveryCodesRequestObject) (api.RegenerateRecoveryCodesResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	u := p.User
	if !hasMFA(u) {
		return nil, conflict("two-factor sign-in is off")
	}
	if _, err := h.checkCode(ctx, h.deps.Store.Queries, u, req.Body.Code); err != nil {
		return nil, codeError(err, http.StatusBadRequest)
	}
	var codes []string
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		codes, err = newRecoveryCodes(ctx, q, u.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.recovery_codes_replaced", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username})
	return api.RegenerateRecoveryCodes200JSONResponse{Codes: codes}, nil
}

func (h *handlers) ResetUserMfa(ctx context.Context, req api.ResetUserMfaRequestObject) (api.ResetUserMfaResponseObject, error) {
	me, err := requireInstanceAdmin(ctx)
	if err != nil {
		return nil, err
	}
	if req.UserId == me.User.ID {
		return nil, badRequest("turn your own two-factor sign-in off under Account › Security")
	}
	var target db.User
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if target, err = h.loadUser(ctx, q, req.UserId); err != nil {
			return err
		}
		if !hasMFA(target) {
			return conflict("%s doesn't use two-factor sign-in", target.Username)
		}
		if err := q.DisableMFA(ctx, target.ID); err != nil {
			return err
		}
		if err := q.DeleteRecoveryCodes(ctx, target.ID); err != nil {
			return err
		}
		// Whoever has their device shouldn't stay signed in either.
		if err := q.DeleteUserAccessTokens(ctx, target.ID); err != nil {
			return err
		}
		// Their password is now the only way in, and may be shorter than
		// that needs: they choose a new one at next sign-in.
		if target.HasPassword {
			if _, err := q.SetPasswordChangeRequired(ctx, db.SetPasswordChangeRequiredParams{ID: target.ID, PasswordChangeRequired: true}); err != nil {
				return err
			}
		}
		return q.DeleteUserSessions(ctx, target.ID)
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.mfa_reset", TargetType: "user", TargetID: target.ID.String(), TargetName: target.Username})
	h.notify(ctx, target, "Two-factor sign-in was reset", fmt.Sprintf("An instance admin (%s) turned off two-factor sign-in", me.User.Username))
	return api.ResetUserMfa204Response{}, nil
}
