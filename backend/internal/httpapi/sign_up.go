package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/store/db"
)

// Open sign-up (Instance › Sign-up). Off by default. When it's on, someone
// gives an email address and gets a link; following it, they choose a
// username and password and the account is made. The account doesn't exist
// until the address is proven, so bots can't fill the users list or claim
// names. While approval is required, new accounts wait for an instance
// admin's (Instance › Users) before they can sign in.

const (
	signUpKey = "sign_up"
	signUpTTL = 24 * time.Hour
)

type signUpSettings struct {
	Enabled         bool     `json:"enabled"`
	AllowedDomains  []string `json:"allowed_domains"`
	NotifyAdmins    bool     `json:"notify_admins"`
	RequireApproval bool     `json:"require_approval"`
}

func readSignUpSettings(ctx context.Context, q *db.Queries) (signUpSettings, error) {
	s := signUpSettings{NotifyAdmins: true, AllowedDomains: []string{}}
	row, err := q.GetInstanceSetting(ctx, signUpKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, nil
	} else if err != nil {
		return s, err
	}
	if err := json.Unmarshal(row.Value, &s); err != nil {
		return s, err
	}
	if s.AllowedDomains == nil {
		s.AllowedDomains = []string{}
	}
	return s, nil
}

// signUpOpen reports whether people can sign up now: it's on, and email
// works (the links go by email).
func (h *handlers) signUpOpen(s signUpSettings) bool { return s.Enabled && h.mailer != nil }

var errSignUpClosed = newError(http.StatusNotFound, "You can't create your own account on this Supermixer; ask an instance admin for one")

var errApprovalPending error = &apiError{status: http.StatusForbidden, code: "approval_pending",
	message: "Your account is waiting for an instance admin's approval. We'll email you when it's ready."}

var errSignUpGone = newError(http.StatusGone, "This link has expired or was already used; ask for a new one")

// cleanDomains lowercases, checks (with the organization SSO settings'
// domainPattern) and de-duplicates allowed domains.
func cleanDomains(in []string) ([]string, error) {
	out := []string{}
	for _, d := range in {
		d = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(d)), "@")
		if d == "" {
			continue
		}
		if len(d) > 253 || !domainPattern.MatchString(d) {
			return nil, badRequest("%q isn't a domain like example.com", d)
		}
		if !slices.Contains(out, d) {
			out = append(out, d)
		}
	}
	if len(out) > 100 {
		return nil, badRequest("list at most 100 domains")
	}
	return out, nil
}

// domainAllowed reports whether email (already normalized) may sign up.
func domainAllowed(email string, domains []string) bool {
	if len(domains) == 0 {
		return true
	}
	at := strings.LastIndex(email, "@")
	return at >= 0 && slices.Contains(domains, email[at+1:])
}

func errDomainNotAllowed(domains []string) error {
	return badRequest("Only addresses at %s can sign up here", strings.Join(domains, ", "))
}

// attemptSignUp counts a sign-up request from this address.
func (h *handlers) attemptSignUp(ctx context.Context) error {
	if ok, wait := h.signUpIP.Attempt(reqInfo(ctx).IP); !ok {
		mins := int(math.Ceil(wait.Minutes()))
		return newError(http.StatusTooManyRequests, "Too many sign-up requests from here. Try again in %d minute%s.", mins, plural(mins))
	}
	return nil
}

func (h *handlers) RequestSignUp(ctx context.Context, req api.RequestSignUpRequestObject) (api.RequestSignUpResponseObject, error) {
	s, err := readSignUpSettings(ctx, h.deps.Store.Queries)
	if err != nil {
		return nil, err
	}
	if !h.signUpOpen(s) {
		return nil, errSignUpClosed
	}
	if err := h.attemptSignUp(ctx); err != nil {
		return nil, err
	}
	email, err := normalizeEmail(&req.Body.Email)
	if err != nil {
		return nil, err
	}
	if email == nil {
		return nil, badRequest("enter your email address")
	}
	if !domainAllowed(*email, s.AllowedDomains) {
		return nil, errDomainNotAllowed(s.AllowedDomains)
	}
	// The field people don't see: only bots fill it in. They're told the
	// same as everyone else, and nothing is sent.
	if deref(req.Body.Website) != "" {
		h.deps.Logger.Info("sign-up dropped: the hidden field was filled in", "ip", reqInfo(ctx).IP)
		return api.RequestSignUp202Response{}, nil
	}
	// The rest happens after answering, so how long the answer takes
	// doesn't tell whether the address has an account.
	info := *reqInfo(ctx)
	info.Principal = nil
	h.pending.Add(1)
	go func() {
		defer h.pending.Done()
		bg, cancel := context.WithTimeout(withRequestInfo(context.Background(), &info), time.Minute)
		defer cancel()
		if err := h.sendSignUpLink(bg, *email); err != nil {
			h.deps.Logger.Warn("sign-up link", "err", err)
		}
	}()
	return api.RequestSignUp202Response{}, nil
}

// sendSignUpLink emails a sign-up link to a new address, or, to an address
// that has an account, a note saying so.
func (h *handlers) sendSignUpLink(ctx context.Context, email string) error {
	// A few emails an hour per address: others asking can't fill its inbox.
	if ok, _ := h.signUpMail.Attempt(email); !ok {
		h.deps.Logger.Info("sign-up email not sent: too many for this address lately")
		return nil
	}
	q := h.deps.Store.Queries
	u, err := q.GetUserByEmail(ctx, email)
	switch {
	case err == nil && u.DisabledAt != nil:
		return h.sendEmail(ctx, email, "Your Supermixer account is disabled", emailContent{
			Heading: "Your account is disabled",
			Intro: []string{
				fmt.Sprintf("Someone, hopefully you, asked to sign up to Supermixer at %s with this address. It already has an account, %s, which an instance admin has disabled.", h.host(), u.Username),
				"Ask whoever runs this Supermixer if you need it back.",
			},
		})
	case err == nil && u.WaitingApproval:
		return h.sendEmail(ctx, email, "Your Supermixer account is waiting for approval", emailContent{
			Heading: "Your account is waiting for approval",
			Intro: []string{
				fmt.Sprintf("Someone, hopefully you, asked to sign up to Supermixer at %s with this address. It already has an account, %s, which is waiting for an instance admin's approval.", h.host(), u.Username),
				"We'll email you as soon as it's approved.",
			},
		})
	case err == nil:
		return h.sendEmail(ctx, email, "You already have a Supermixer account", emailContent{
			Heading: "You already have an account",
			Intro: []string{
				fmt.Sprintf("Someone, hopefully you, asked to sign up to Supermixer at %s with this address. It already has an account: %s.", h.host(), u.Username),
				"Sign in with it, or choose a new password if you've forgotten yours.",
			},
			Button: "Sign in",
			Link:   h.joinURL("/sign-in", nil),
			Outro:  []string{"If it wasn't you, ignore this email: nothing has changed."},
		})
	case !errors.Is(err, pgx.ErrNoRows):
		return err
	}

	token, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if err := q.DeleteExpiredSignUps(ctx); err != nil {
			return err
		}
		_, err := q.CreateSignUp(ctx, db.CreateSignUpParams{Email: email, TokenHash: hash, Ip: reqInfo(ctx).IP, ExpiresAt: time.Now().Add(signUpTTL)})
		return err
	})
	if err != nil {
		return err
	}
	return h.sendEmail(ctx, email, "Create your Supermixer account", emailContent{
		Heading: "Create your account",
		Intro: []string{
			fmt.Sprintf("Someone, hopefully you, asked to sign up to Supermixer at %s with this address.", h.host()),
			"Choose your username and password with this link. It works once, for a day.",
		},
		Button: "Create your account",
		Link:   h.joinURL("/sign-up", url.Values{"token": {token}}),
		Outro:  []string{fmt.Sprintf("Asked for from %s. If it wasn't you, ignore this email: no account is made.", reqInfo(ctx).IP)},
	})
}

// signUpLink finds a working sign-up link, while sign-up is open and its
// address may still sign up.
func (h *handlers) signUpLink(ctx context.Context, token string) (db.SignUp, signUpSettings, error) {
	q := h.deps.Store.Queries
	s, err := readSignUpSettings(ctx, q)
	if err != nil {
		return db.SignUp{}, s, err
	}
	if !h.signUpOpen(s) {
		return db.SignUp{}, s, errSignUpClosed
	}
	row, err := q.GetSignUp(ctx, auth.HashToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return row, s, errSignUpGone
	} else if err != nil {
		return row, s, err
	}
	if !domainAllowed(row.Email, s.AllowedDomains) {
		return row, s, errDomainNotAllowed(s.AllowedDomains)
	}
	return row, s, nil
}

func (h *handlers) GetSignUp(ctx context.Context, req api.GetSignUpRequestObject) (api.GetSignUpResponseObject, error) {
	row, s, err := h.signUpLink(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	return api.GetSignUp200JSONResponse{Email: row.Email, ExpiresAt: row.ExpiresAt, ApprovalRequired: s.RequireApproval}, nil
}

type signUpResponse struct{ withCookies }

func (r signUpResponse) VisitCompleteSignUpResponse(w http.ResponseWriter) error { return r.visit(w) }

func (h *handlers) CompleteSignUp(ctx context.Context, req api.CompleteSignUpRequestObject) (api.CompleteSignUpResponseObject, error) {
	ipKey := "sign-up-complete-ip:" + reqInfo(ctx).IP
	if err := h.attempt("attempts", ipKey); err != nil {
		return nil, err
	}
	row, s, err := h.signUpLink(ctx, req.Token)
	if err != nil {
		return nil, err
	}
	b := req.Body
	params, err := newUserParams(b.Username, b.Password, &row.Email, deref(b.DisplayName))
	if err != nil {
		return nil, err
	}
	params.WaitingApproval = s.RequireApproval
	var user db.User
	var cookies []*http.Cookie
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if _, err := q.UseSignUp(ctx, row.ID); errors.Is(err, pgx.ErrNoRows) {
			return errSignUpGone
		} else if err != nil {
			return err
		}
		if user, err = q.CreateUser(ctx, params); err != nil {
			return createUserErr(err)
		}
		// The address's other links stop working.
		if err := q.DeleteSignUpsForEmail(ctx, row.Email); err != nil {
			return err
		}
		reqInfo(ctx).Principal = &principal{User: user}
		if user.WaitingApproval {
			return nil
		}
		cookies, err = h.startSession(ctx, q, user.ID, "")
		return err
	})
	if err != nil {
		return nil, err
	}
	h.limiter.Reset(ipKey)
	h.audit(ctx, nil, auditEntry{Action: "user.signed_up", TargetType: "user", TargetID: user.ID.String(), TargetName: user.Username,
		Metadata: map[string]any{"email": row.Email, "waiting_approval": user.WaitingApproval}})
	if s.NotifyAdmins {
		h.tellAdminsAboutSignUp(ctx, user)
	}
	if user.WaitingApproval {
		return signUpResponse{withCookies{status: http.StatusAccepted}}, nil
	}
	return signUpResponse{withCookies{status: http.StatusCreated, body: toProfile(user), cookies: cookies}}, nil
}

// tellAdminsAboutSignUp emails instance admins about a new account.
func (h *handlers) tellAdminsAboutSignUp(ctx context.Context, u db.User) {
	emails, err := h.deps.Store.Queries.ListInstanceAdminEmails(ctx)
	if err != nil {
		h.deps.Logger.Warn("sign-up: listing instance admins to tell", "err", err)
		return
	}
	who := u.Username
	if u.Email != nil {
		who += " (" + *u.Email + ")"
	}
	c := emailContent{
		Heading: "New account: " + u.Username,
		Intro:   []string{fmt.Sprintf("%s created an account on Supermixer at %s.", who, h.host())},
		Button:  "See users",
		Link:    h.joinURL("/admin/users", nil),
		Outro:   []string{"You get these emails because you're an instance admin. Turn them off under Instance › Sign-up."},
	}
	subject := "New Supermixer account: " + u.Username
	if u.WaitingApproval {
		c.Heading = u.Username + " is waiting for your approval"
		c.Intro = []string{fmt.Sprintf("%s signed up to Supermixer at %s, and can't sign in until an instance admin approves the account.", who, h.host())}
		c.Button = "Approve or decline"
		subject = "Waiting for approval: " + u.Username
	}
	for _, to := range emails {
		h.sendLater(to, subject, c)
	}
}

func (h *handlers) GetSignUpSettings(ctx context.Context, _ api.GetSignUpSettingsRequestObject) (api.GetSignUpSettingsResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	s, err := readSignUpSettings(ctx, h.deps.Store.Queries)
	if err != nil {
		return nil, err
	}
	return api.GetSignUpSettings200JSONResponse(toSignUpSettings(s)), nil
}

func toSignUpSettings(s signUpSettings) api.SignUpSettings {
	return api.SignUpSettings{Enabled: s.Enabled, AllowedDomains: s.AllowedDomains, NotifyAdmins: s.NotifyAdmins, RequireApproval: s.RequireApproval}
}

func (h *handlers) SetSignUpSettings(ctx context.Context, req api.SetSignUpSettingsRequestObject) (api.SetSignUpSettingsResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	b := req.Body
	domains, err := cleanDomains(b.AllowedDomains)
	if err != nil {
		return nil, err
	}
	if b.Enabled && h.mailer == nil {
		return nil, conflict("sign-up sends links by email, and this Supermixer can't send email: set up [email] in its configuration first")
	}
	s := signUpSettings{Enabled: b.Enabled, AllowedDomains: domains, NotifyAdmins: b.NotifyAdmins, RequireApproval: b.RequireApproval}
	value, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	if err := h.deps.Store.Queries.SetInstanceSetting(ctx, db.SetInstanceSettingParams{Key: signUpKey, Value: value}); err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "instance.sign_up_updated", TargetType: "instance", TargetName: "Sign-up",
		Metadata: map[string]any{"enabled": s.Enabled, "allowed_domains": s.AllowedDomains, "notify_admins": s.NotifyAdmins, "require_approval": s.RequireApproval}})
	return api.SetSignUpSettings200JSONResponse(toSignUpSettings(s)), nil
}

func (h *handlers) ApproveUser(ctx context.Context, req api.ApproveUserRequestObject) (api.ApproveUserResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	u, err := h.deps.Store.Queries.ApproveUser(ctx, req.UserId)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, conflict("this account isn't waiting for approval")
	} else if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.approved", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username})
	if u.Email != nil {
		h.sendLater(*u.Email, "Your Supermixer account is ready", emailContent{
			Heading: "Your account is ready",
			Intro:   []string{fmt.Sprintf("An instance admin approved your account, %s, on Supermixer at %s. You can sign in now.", u.Username, h.host())},
			Button:  "Sign in",
			Link:    h.joinURL("/sign-in", nil),
		})
	}
	return api.ApproveUser200JSONResponse(toUser(u)), nil
}

func (h *handlers) DeclineUser(ctx context.Context, req api.DeclineUserRequestObject) (api.DeclineUserResponseObject, error) {
	if _, err := requireInstanceAdmin(ctx); err != nil {
		return nil, err
	}
	u, err := h.deps.Store.Queries.DeleteWaitingUser(ctx, req.UserId)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, conflict("this account isn't waiting for approval; disable it instead")
	} else if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.declined", TargetType: "user", TargetID: u.ID.String(), TargetName: u.Username,
		Metadata: map[string]any{"email": deref(u.Email)}})
	if u.Email != nil {
		h.sendLater(*u.Email, "Your Supermixer sign-up", emailContent{
			Heading: "Your sign-up wasn't accepted",
			Intro:   []string{fmt.Sprintf("An instance admin declined your request for an account on Supermixer at %s, and it has been removed.", h.host())},
			Outro:   []string{"If you think this is a mistake, contact whoever runs this Supermixer."},
		})
	}
	return api.DeclineUser204Response{}, nil
}
