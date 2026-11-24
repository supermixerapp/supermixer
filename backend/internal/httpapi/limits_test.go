package httpapi

import (
	"sync"
	"testing"
)

func TestResourceLimits(t *testing.T) {
	env := newTestEnv(t)
	admin := env.client(t)
	admin.signIn("admin", adminPassword)
	gw := fakeGateway(t)
	register := func(c *client, org, name string) int {
		return c.do("POST", "/organizations/"+org+"/projects", map[string]any{"name": name, "connection": connectionFor(t, gw, env.dbURL)}, nil)
	}

	type limits struct {
		MaxOrgs     *int `json:"max_organizations_per_user"`
		MaxProjects *int `json:"max_projects_per_organization"`
		MostOrgs    int  `json:"most_organizations_by_one_person"`
		MostProj    int  `json:"most_projects_in_one_organization"`
	}
	var l limits
	admin.must(200, "GET", "/admin/limits", nil, &l)
	if l.MaxOrgs != nil || l.MaxProjects != nil {
		t.Fatalf("defaults = %+v", l)
	}
	admin.must(400, "PUT", "/admin/limits", map[string]any{"max_organizations_per_user": 0, "max_projects_per_organization": nil}, nil)
	admin.must(200, "PUT", "/admin/limits", map[string]any{"max_organizations_per_user": 2, "max_projects_per_organization": 3}, &l)
	if l.MaxOrgs == nil || *l.MaxOrgs != 2 || l.MaxProjects == nil || *l.MaxProjects != 3 {
		t.Fatalf("saved = %+v", l)
	}

	// A person may create two organizations, then no more; deleting one makes room.
	admin.must(201, "POST", "/admin/users", map[string]any{"username": "limited", "password": "limited-long-password", "require_password_change": false}, nil)
	user := env.client(t)
	user.signIn("limited", "limited-long-password")
	user.must(403, "GET", "/admin/limits", nil, nil)
	user.must(201, "POST", "/organizations", map[string]string{"name": "Lim One"}, nil)
	user.must(201, "POST", "/organizations", map[string]string{"name": "Lim Two"}, nil)
	var refused struct{ Code, Message string }
	if s := user.do("POST", "/organizations", map[string]string{"name": "Lim Three"}, &refused); s != 403 || refused.Code != "limit_reached" {
		t.Fatalf("third organization: %d %+v", s, refused)
	}
	var mine struct {
		Created int  `json:"organizations_created"`
		Max     *int `json:"max_organizations"`
	}
	user.must(200, "GET", "/profile/limits", nil, &mine)
	if mine.Created != 2 || mine.Max == nil || *mine.Max != 2 {
		t.Fatalf("my limits = %+v", mine)
	}
	user.must(204, "DELETE", "/organizations/lim-two", nil, nil)
	user.must(201, "POST", "/organizations", map[string]string{"name": "Lim Three"}, nil)
	// Instance admins aren't held to it.
	for _, name := range []string{"Adm A", "Adm B", "Adm C"} {
		admin.must(201, "POST", "/organizations", map[string]string{"name": name}, nil)
	}

	// Projects: the instance allows three per organization.
	for _, name := range []string{"P1", "P2", "P3"} {
		if s := register(user, "lim-one", name); s != 201 {
			t.Fatalf("registering %s: %d", name, s)
		}
	}
	if s := register(user, "lim-one", "P4"); s != 403 {
		t.Fatalf("fourth project: %d", s)
	}
	type orgLimits struct {
		Own      *int `json:"max_projects"`
		Instance *int `json:"instance_max_projects"`
		Limit    *int `json:"project_limit"`
		Count    int  `json:"project_count"`
	}
	var ol orgLimits
	user.must(200, "GET", "/organizations/lim-one/limits", nil, &ol)
	if ol.Own != nil || ol.Instance == nil || *ol.Instance != 3 || ol.Limit == nil || *ol.Limit != 3 || ol.Count != 3 {
		t.Fatalf("organization limits = %+v", ol)
	}

	// Its own limit: only up to the instance's; the lower one applies.
	user.must(400, "PUT", "/organizations/lim-three/limits", map[string]any{"max_projects": 4}, nil)
	user.must(200, "PUT", "/organizations/lim-three/limits", map[string]any{"max_projects": 1}, &ol)
	if ol.Own == nil || *ol.Own != 1 || ol.Limit == nil || *ol.Limit != 1 {
		t.Fatalf("own limit = %+v", ol)
	}
	var org struct {
		ProjectLimit *int `json:"project_limit"`
	}
	user.must(200, "GET", "/organizations/lim-three", nil, &org)
	if org.ProjectLimit == nil || *org.ProjectLimit != 1 {
		t.Fatalf("organization's project_limit = %v", org.ProjectLimit)
	}
	if s := register(user, "lim-three", "Q1"); s != 201 {
		t.Fatalf("first project under its own limit: %d", s)
	}
	if s := register(user, "lim-three", "Q2"); s != 403 {
		t.Fatalf("past its own limit: %d", s)
	}
	// Moving a project into a full organization is refused too.
	var projects []struct {
		Ref              string
		Name             string
		OrganizationSlug string `json:"organization_slug"`
	}
	user.must(200, "GET", "/projects", nil, &projects)
	var p1 string
	for _, p := range projects {
		if p.Name == "P1" {
			p1 = p.Ref
		}
	}
	user.must(403, "POST", "/projects/"+p1+"/transfer", map[string]string{"organization_slug": "lim-three"}, nil)

	// Who may set an organization's limit: Owners and Administrators.
	// The instance admin makes the accounts; the organization's Owner invites them.
	join := func(username, role string) *client {
		admin.must(201, "POST", "/admin/users", map[string]any{"username": username, "password": username + "-long-password", "require_password_change": false}, nil)
		var inv struct{ Token string }
		user.must(201, "POST", "/organizations/lim-three/invitations", map[string]any{"role": role}, &inv)
		c := env.client(t)
		c.signIn(username, username+"-long-password")
		c.must(200, "POST", "/invitations/"+inv.Token+"/accept", nil, nil)
		return c
	}
	adminMember := join("limadmin", "administrator")
	adminMember.must(200, "PUT", "/organizations/lim-three/limits", map[string]any{"max_projects": nil}, nil)
	dev := join("limdev", "developer")
	dev.must(403, "PUT", "/organizations/lim-three/limits", map[string]any{"max_projects": 2}, nil)
	dev.must(200, "GET", "/organizations/lim-three/limits", nil, nil)

	// Lowering the instance's limit keeps what exists and stops new ones.
	admin.must(200, "PUT", "/admin/limits", map[string]any{"max_organizations_per_user": nil, "max_projects_per_organization": 2}, &l)
	if l.MostProj != 3 || l.MostOrgs < 2 {
		t.Fatalf("usage = %+v", l)
	}
	user.must(200, "GET", "/organizations/lim-one/limits", nil, &ol)
	if ol.Count != 3 || ol.Limit == nil || *ol.Limit != 2 {
		t.Fatalf("after lowering = %+v", ol)
	}
	user.must(201, "POST", "/organizations", map[string]string{"name": "Lim Four"}, nil) // no per-person limit now

	// Two at once can't both take the last place.
	admin.must(200, "PUT", "/admin/limits", map[string]any{"max_organizations_per_user": nil, "max_projects_per_organization": 1}, nil)
	user.must(201, "POST", "/organizations", map[string]string{"name": "Race"}, nil)
	statuses := make([]int, 6)
	var wg sync.WaitGroup
	for i := range statuses {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			statuses[i] = register(user, "race", "R")
		}(i)
	}
	wg.Wait()
	created := 0
	for _, s := range statuses {
		if s == 201 {
			created++
		} else if s != 403 {
			t.Errorf("racing registration: %d", s)
		}
	}
	if created != 1 {
		t.Fatalf("%d of the racing registrations succeeded (%v), want 1", created, statuses)
	}

	var audit struct {
		Entries []struct{ Action string } `json:"entries"`
	}
	admin.must(200, "GET", "/admin/audit-logs?action=instance.limits", nil, &audit)
	// Three saves; the refused one isn't recorded.
	if len(audit.Entries) != 3 {
		t.Errorf("%d instance.limits_updated entries, want 3", len(audit.Entries))
	}
}
