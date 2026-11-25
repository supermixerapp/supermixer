package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"golang.org/x/oauth2"
)

// GitHub sign-in (sso.providers type = "github"): an OAuth App, since GitHub
// doesn't do OpenID Connect for this. The token from the sign-in is used
// once, to read who the person is, and then dropped: their user ID (the
// identity, as it never changes, unlike a username or address), username and
// name from GET /user, and their verified email address from
// GET /user/emails. It asks only for user:email.

func (p *ssoProvider) isGitHub() bool { return p.cfg.Type == "github" }

// githubEndpoint is where a GitHub (or GitHub Enterprise Server) signs in.
func (p *ssoProvider) githubEndpoint() oauth2.Endpoint {
	return oauth2.Endpoint{
		AuthURL:   p.cfg.GitHubURL + "/login/oauth/authorize",
		TokenURL:  p.cfg.GitHubURL + "/login/oauth/access_token",
		AuthStyle: oauth2.AuthStyleInParams,
	}
}

// githubAPI is the REST API's address.
func (p *ssoProvider) githubAPI() string {
	if p.cfg.GitHubURL == "https://github.com" {
		return "https://api.github.com"
	}
	return p.cfg.GitHubURL + "/api/v3"
}

// usesPKCE: github.com supports PKCE; some GitHub Enterprise Server
// versions don't, so it's only used there for OpenID Connect providers.
func (p *ssoProvider) usesPKCE() bool {
	return !p.isGitHub() || p.cfg.GitHubURL == "https://github.com"
}

type githubUser struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Name  string `json:"name"`
}

type githubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

// githubGet reads one API response into out.
func (p *ssoProvider) githubGet(ctx context.Context, tok *oauth2.Token, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.githubAPI()+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := ssoHTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", path, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

// githubIdentity is who signed in: the user ID as the subject, the primary
// address if GitHub verified it (otherwise the first verified one; empty if
// none is), and their username and name.
func (p *ssoProvider) githubIdentity(ctx context.Context, tok *oauth2.Token) (string, string, ssoClaims, error) {
	var u githubUser
	if err := p.githubGet(ctx, tok, "/user", &u); err != nil {
		return "", "", ssoClaims{}, err
	}
	if u.ID <= 0 {
		return "", "", ssoClaims{}, errors.New("GET /user: no user ID")
	}
	var emails []githubEmail
	if err := p.githubGet(ctx, tok, "/user/emails?per_page=100", &emails); err != nil {
		return "", "", ssoClaims{}, err
	}
	return strconv.FormatInt(u.ID, 10), pickGitHubEmail(emails), ssoClaims{Name: u.Name, PreferredUsername: u.Login}, nil
}

// noReplyAddress is GitHub's stand-in for a private address
// (…@users.noreply.github.com, or users.noreply.<host> on GitHub
// Enterprise Server), which can't receive mail.
func noReplyAddress(email string) bool {
	at := strings.LastIndex(email, "@")
	return at >= 0 && strings.HasPrefix(strings.ToLower(email[at+1:]), "users.noreply.")
}

// pickGitHubEmail is the primary address if it's verified, else the first
// verified one, normalized; empty if there's none. No-reply addresses
// don't count: password resets and notices couldn't reach them.
func pickGitHubEmail(emails []githubEmail) string {
	pick := ""
	for _, e := range emails {
		if !e.Verified || noReplyAddress(e.Email) {
			continue
		}
		if e.Primary {
			pick = e.Email
			break
		}
		if pick == "" {
			pick = e.Email
		}
	}
	if n, err := normalizeEmail(&pick); err == nil && n != nil {
		return *n
	}
	return ""
}
