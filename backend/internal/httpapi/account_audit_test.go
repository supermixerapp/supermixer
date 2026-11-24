package httpapi

import (
	"net/http"
	"testing"
)

func TestMyAuditLog(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	admin.must(201, "POST", "/organizations", map[string]string{"name": "Mine"}, nil)
	bob := joinAs(t, env, admin, "mine", "bob", "developer")

	type entry struct {
		Action           string
		ActorUsername    string  `json:"actor_username"`
		TargetName       string  `json:"target_name"`
		IP               string  `json:"ip"`
		OrganizationSlug *string `json:"organization_slug"`
	}
	var page struct {
		Entries    []entry
		NextBefore *int64 `json:"next_before"`
	}
	find := func(es []entry, action, by string) *entry {
		for i := range es {
			if es[i].Action == action && es[i].ActorUsername == by {
				return &es[i]
			}
		}
		return nil
	}

	// Bob's own: signing in, joining; with his IP address and the organization.
	bob.must(200, "GET", "/profile/audit-logs", nil, &page)
	if e := find(page.Entries, "user.signed_in", "bob"); e == nil || e.IP == "" {
		t.Fatalf("bob's sign-in: %+v", page.Entries)
	}
	if e := find(page.Entries, "member.joined", "bob"); e == nil || e.OrganizationSlug == nil || *e.OrganizationSlug != "mine" {
		t.Fatalf("joining: %+v", page.Entries)
	}
	// Not the admin's own doings...
	if find(page.Entries, "organization.created", "admin") != nil {
		t.Fatal("bob sees the admin's entries")
	}
	// ...but what the admin did to his account, without the admin's IP.
	var users []struct{ ID, Username string }
	admin.must(200, "GET", "/admin/users", nil, &users)
	for _, u := range users {
		if u.Username == "bob" {
			admin.must(204, "DELETE", "/admin/users/"+u.ID+"/sessions", nil, nil)
		}
	}
	bob = env.client(t)
	bob.signIn("bob", "bob-long-password")
	bob.must(200, "GET", "/profile/audit-logs", nil, &page)
	e := find(page.Entries, "user.signed_out_everywhere", "admin")
	if e == nil || e.TargetName != "bob" || e.IP != "" {
		t.Fatalf("the admin's change: %+v", page.Entries)
	}

	// Paging and filtering.
	bob.must(200, "GET", "/profile/audit-logs?limit=1&action=user.signed_in", nil, &page)
	if len(page.Entries) != 1 || page.Entries[0].Action != "user.signed_in" || page.NextBefore == nil {
		t.Fatalf("page = %+v", page)
	}

	// Signed-in sessions only, not access tokens.
	var tok struct{ Token string }
	bob.must(201, "POST", "/profile/access-tokens", map[string]any{"name": "ci", "expires_in_days": 1}, &tok)
	req, _ := http.NewRequest("GET", env.server.URL+"/api/v1/profile/audit-logs", nil)
	req.Header.Set("Authorization", "Bearer "+tok.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("with a token: %d", resp.StatusCode)
	}
}
