package rbac

import "testing"

// The full matrix, so any change to who can do what is deliberate.
func TestOrgMatrix(t *testing.T) {
	want := map[Permission][]Role{
		OrgRead:          {Owner, Administrator, Developer, ReadOnly, NoAccess},
		OrgUpdate:        {Owner},
		OrgDelete:        {Owner},
		MembersRead:      {Owner, Administrator, Developer, ReadOnly},
		MembersInvite:    {Owner, Administrator},
		MembersUpdate:    {Owner, Administrator},
		MembersRemove:    {Owner, Administrator},
		ProjectsCreate:   {Owner, Administrator},
		AuditRead:        {Owner, Administrator},
		OrgProjectsRead:  {Owner, Administrator, Developer, ReadOnly},
		ProjectsTransfer: {Owner},
		OrgLimitsUpdate:  {Owner, Administrator},
	}
	for perm, allowed := range want {
		for _, role := range OrgRoles {
			expect := contains(allowed, role)
			if got := OrgCan(role, perm); got != expect {
				t.Errorf("OrgCan(%s, %s) = %v, want %v", role, perm, got, expect)
			}
		}
	}
}

func TestProjectMatrix(t *testing.T) {
	want := map[Permission][]Role{
		ProjectRead:            {Owner, Administrator, Developer, ReadOnly},
		ProjectUpdate:          {Owner, Administrator},
		ProjectDelete:          {Owner, Administrator},
		ProjectSecretsRead:     {Owner, Administrator, Developer},
		ProjectDataRead:        {Owner, Administrator, Developer, ReadOnly},
		ProjectDataWrite:       {Owner, Administrator, Developer},
		ProjectFunctionsDeploy: {Owner, Administrator, Developer},
	}
	for perm, allowed := range want {
		for _, role := range OrgRoles {
			expect := contains(allowed, role)
			if got := ProjectCan(role, perm); got != expect {
				t.Errorf("ProjectCan(%s, %s) = %v, want %v", role, perm, got, expect)
			}
		}
	}
}

// Deployed function code can read the stack's keys, so deploying must never
// be granted without seeing secrets.
func TestDeployingFunctionsNeedsSecrets(t *testing.T) {
	for _, role := range OrgRoles {
		if ProjectCan(role, ProjectFunctionsDeploy) && !ProjectCan(role, ProjectSecretsRead) {
			t.Errorf("%s may deploy functions but not see secrets", role)
		}
	}
}

func TestEffectiveProjectRole(t *testing.T) {
	dev := Developer
	if got := EffectiveProjectRole(NoAccess, &dev); got != Developer {
		t.Errorf("project-scoped role should win, got %s", got)
	}
	ro := ReadOnly
	if got := EffectiveProjectRole(Administrator, &ro); got != ReadOnly {
		t.Errorf("project-scoped role can narrow access, got %s", got)
	}
	if got := EffectiveProjectRole(Developer, nil); got != Developer {
		t.Errorf("falls back to org role, got %s", got)
	}
}

func TestCanAssign(t *testing.T) {
	cases := []struct {
		actor, target Role
		want          bool
	}{
		{Owner, Owner, true},
		{Owner, Developer, true},
		{Administrator, Owner, false},
		{Administrator, Administrator, true},
		{Administrator, ReadOnly, true},
		{Developer, ReadOnly, false},
		{ReadOnly, ReadOnly, false},
	}
	for _, c := range cases {
		if got := CanAssign(c.actor, c.target); got != c.want {
			t.Errorf("CanAssign(%s, %s) = %v, want %v", c.actor, c.target, got, c.want)
		}
	}
}

func contains(rs []Role, r Role) bool {
	for _, x := range rs {
		if x == r {
			return true
		}
	}
	return false
}
