package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/mail"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"supermixer/internal/api"
	"supermixer/internal/auth"
	"supermixer/internal/rbac"
	"supermixer/internal/store/db"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$`)

func normalizeUsername(s string) (string, error) {
	u := strings.ToLower(strings.TrimSpace(s))
	if !usernamePattern.MatchString(u) {
		return "", badRequest("username must be 3–40 characters: letters, digits, '.', '_' or '-', starting and ending with a letter or digit")
	}
	return u, nil
}

func normalizeEmail(s *string) (*string, error) {
	if s == nil {
		return nil, nil
	}
	e := strings.TrimSpace(*s)
	if e == "" {
		return nil, nil
	}
	if _, err := mail.ParseAddress(e); err != nil || len(e) > 254 || strings.ContainsAny(e, "<> ") {
		return nil, badRequest("%q is not a valid email address", e)
	}
	e = strings.ToLower(e)
	return &e, nil
}

func validDisplayName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len([]rune(s)) > 64 {
		return "", badRequest("display name must be at most 64 characters")
	}
	return s, nil
}

func toProfile(u db.User) api.Profile {
	return api.Profile{
		Id:              u.ID,
		Username:        u.Username,
		Email:           u.Email,
		DisplayName:     u.DisplayName,
		IsInstanceAdmin: u.IsInstanceAdmin,
		DefaultPassword: u.DefaultPassword,
		CreatedAt:       u.CreatedAt,
	}
}

// withCookies wraps a JSON response so it can also set cookies.
type withCookies struct {
	status  int
	body    any
	cookies []*http.Cookie
}

func (r withCookies) visit(w http.ResponseWriter) error {
	for _, c := range r.cookies {
		http.SetCookie(w, c)
	}
	if r.body == nil {
		w.WriteHeader(r.status)
		return nil
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(r.status)
	return json.NewEncoder(w).Encode(r.body)
}

type signInResponse struct{ withCookies }

func (r signInResponse) VisitSignInResponse(w http.ResponseWriter) error { return r.visit(w) }

type signOutResponse struct{ withCookies }

func (r signOutResponse) VisitSignOutResponse(w http.ResponseWriter) error { return r.visit(w) }

type invitationSignUpResponse struct{ withCookies }

func (r invitationSignUpResponse) VisitSignUpWithInvitationResponse(w http.ResponseWriter) error {
	return r.visit(w)
}

func (h *handlers) SignIn(ctx context.Context, req api.SignInRequestObject) (api.SignInResponseObject, error) {
	username := strings.ToLower(strings.TrimSpace(req.Body.Username))
	ipKey, userKey := "ip:"+reqInfo(ctx).IP, "user:"+username
	for _, key := range []string{ipKey, userKey} {
		if blocked, wait := h.limiter.Blocked(key); blocked {
			mins := int(math.Ceil(wait.Minutes()))
			return nil, newError(http.StatusTooManyRequests, "Too many sign-in attempts. Try again in %d minute%s.", mins, plural(mins))
		}
	}

	fail := func() (api.SignInResponseObject, error) {
		h.limiter.Fail(ipKey)
		h.limiter.Fail(userKey)
		return nil, newError(http.StatusUnauthorized, "Invalid username or password")
	}

	user, err := h.deps.Store.Queries.GetUserByUsername(ctx, username)
	if errors.Is(err, pgx.ErrNoRows) {
		auth.VerifyDummy(req.Body.Password)
		return fail()
	} else if err != nil {
		return nil, err
	}
	if err := auth.VerifyPassword(user.PasswordHash, req.Body.Password); err != nil || user.DisabledAt != nil {
		return fail()
	}
	h.limiter.Reset(ipKey)
	h.limiter.Reset(userKey)

	cookies, err := h.startSession(ctx, h.deps.Store.Queries, user.ID)
	if err != nil {
		return nil, err
	}
	reqInfo(ctx).Principal = &principal{User: user}
	h.audit(ctx, nil, auditEntry{Action: "user.signed_in", TargetType: "user", TargetID: user.ID.String(), TargetName: user.Username})
	return signInResponse{withCookies{status: http.StatusOK, body: toProfile(user), cookies: cookies}}, nil
}

func (h *handlers) SignOut(ctx context.Context, _ api.SignOutRequestObject) (api.SignOutResponseObject, error) {
	if p := reqInfo(ctx).Principal; p != nil {
		if err := h.deps.Store.Queries.DeleteSession(ctx, p.Session.ID); err != nil {
			return nil, err
		}
	}
	return signOutResponse{withCookies{status: http.StatusNoContent, cookies: clearedCookies()}}, nil
}

func (h *handlers) GetProfile(ctx context.Context, _ api.GetProfileRequestObject) (api.GetProfileResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	return api.GetProfile200JSONResponse(toProfile(p.User)), nil
}

func (h *handlers) UpdateProfile(ctx context.Context, req api.UpdateProfileRequestObject) (api.UpdateProfileResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	u := p.User
	if req.Body.DisplayName != nil {
		if u.DisplayName, err = validDisplayName(*req.Body.DisplayName); err != nil {
			return nil, err
		}
	}
	if req.Body.Email != nil {
		if u.Email, err = normalizeEmail(req.Body.Email); err != nil {
			return nil, err
		}
	}
	updated, err := h.deps.Store.Queries.UpdateUser(ctx, db.UpdateUserParams{
		ID: u.ID, DisplayName: u.DisplayName, Email: u.Email, IsInstanceAdmin: u.IsInstanceAdmin, DisabledAt: u.DisabledAt,
	})
	if isUniqueViolation(err) {
		return nil, conflict("another account already uses that email address")
	} else if err != nil {
		return nil, err
	}
	return api.UpdateProfile200JSONResponse(toProfile(updated)), nil
}

func (h *handlers) ChangePassword(ctx context.Context, req api.ChangePasswordRequestObject) (api.ChangePasswordResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	if err := auth.VerifyPassword(p.User.PasswordHash, req.Body.CurrentPassword); err != nil {
		return nil, badRequest("current password is incorrect")
	}
	if err := auth.ValidateNewPassword(req.Body.NewPassword); err != nil {
		return nil, badRequest("%s", err.Error())
	}
	if req.Body.NewPassword == req.Body.CurrentPassword {
		return nil, badRequest("choose a password different from the current one")
	}
	hash, err := auth.HashPassword(req.Body.NewPassword)
	if err != nil {
		return nil, err
	}
	err = h.deps.Store.InTx(ctx, func(q *db.Queries) error {
		if err := q.SetUserPassword(ctx, db.SetUserPasswordParams{ID: p.User.ID, PasswordHash: hash, DefaultPassword: false}); err != nil {
			return err
		}
		return q.DeleteOtherUserSessions(ctx, db.DeleteOtherUserSessionsParams{UserID: p.User.ID, ID: p.Session.ID})
	})
	if err != nil {
		return nil, err
	}
	h.audit(ctx, nil, auditEntry{Action: "user.password_changed", TargetType: "user", TargetID: p.User.ID.String(), TargetName: p.User.Username})
	return api.ChangePassword204Response{}, nil
}

func (h *handlers) ListSessions(ctx context.Context, _ api.ListSessionsRequestObject) (api.ListSessionsResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := h.deps.Store.Queries.ListUserSessions(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	out := make(api.ListSessions200JSONResponse, 0, len(rows))
	for _, s := range rows {
		out = append(out, api.Session{
			Id: s.ID, CreatedAt: s.CreatedAt, LastSeenAt: s.LastSeenAt, ExpiresAt: s.ExpiresAt,
			Ip: s.Ip, UserAgent: s.UserAgent, Current: s.ID == p.Session.ID,
		})
	}
	return out, nil
}

func (h *handlers) RevokeSession(ctx context.Context, req api.RevokeSessionRequestObject) (api.RevokeSessionResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	n, err := h.deps.Store.Queries.DeleteUserSession(ctx, db.DeleteUserSessionParams{ID: req.SessionId, UserID: p.User.ID})
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, notFound("session")
	}
	return api.RevokeSession204Response{}, nil
}

func (h *handlers) GetPermissions(ctx context.Context, _ api.GetPermissionsRequestObject) (api.GetPermissionsResponseObject, error) {
	p, err := currentUser(ctx)
	if err != nil {
		return nil, err
	}
	orgs, projects, err := h.visibleProjects(ctx, p.User.ID)
	if err != nil {
		return nil, err
	}
	byOrg := map[uuid.UUID][]api.ProjectPermissions{}
	for _, vp := range projects {
		byOrg[vp.Row.Project.OrganizationID] = append(byOrg[vp.Row.Project.OrganizationID], api.ProjectPermissions{
			Ref: vp.Row.Project.Ref, Role: api.OrgRole(vp.Role), Permissions: permStrings(rbac.ProjectPermissions(vp.Role)),
		})
	}
	out := make(api.GetPermissions200JSONResponse, 0, len(orgs))
	for _, o := range orgs {
		ps := byOrg[o.Organization.ID]
		if ps == nil {
			ps = []api.ProjectPermissions{}
		}
		out = append(out, api.OrganizationPermissions{
			OrganizationSlug: o.Organization.Slug,
			Role:             api.OrgRole(o.Role),
			Permissions:      permStrings(rbac.OrgPermissions(rbac.Role(o.Role))),
			Projects:         ps,
		})
	}
	return out, nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// describeRole is used in messages ("an Owner").
func describeRole(r rbac.Role) string {
	names := map[rbac.Role]string{
		rbac.Owner: "Owner", rbac.Administrator: "Administrator", rbac.Developer: "Developer",
		rbac.ReadOnly: "Read-only", rbac.NoAccess: "No access",
	}
	if n, ok := names[r]; ok {
		return n
	}
	return fmt.Sprint(r)
}
