// Package rbac is Supermixer's access-control model, mirroring Supabase's
// organization roles (https://supabase.com/docs/guides/platform/access-control):
//
//   - Owner: everything.
//   - Administrator: everything except changing organization settings,
//     transferring projects out of the organization, and managing Owners.
//   - Developer: works with project data but cannot change project settings,
//     invite members or delete anything.
//   - Read-only: can view, and will run SQL read-only (Stage 2). Cannot see
//     secret API keys.
//   - No access: sees nothing, unless granted project-scoped roles.
//
// A member can also hold project-scoped roles (Administrator, Developer,
// Read-only) on individual projects. On a project, the effective role is the
// project-scoped role if one exists, otherwise the organization role.
package rbac

import "slices"

// Role is an organization or project role.
type Role string

const (
	Owner         Role = "owner"
	Administrator Role = "administrator"
	Developer     Role = "developer"
	ReadOnly      Role = "read_only"
	NoAccess      Role = "no_access"
)

// OrgRoles lists organization roles, most to least privileged.
var OrgRoles = []Role{Owner, Administrator, Developer, ReadOnly, NoAccess}

// ProjectRoles lists roles that can be granted on a single project.
var ProjectRoles = []Role{Administrator, Developer, ReadOnly}

// Permission is an action on an organization or project.
type Permission string

// Organization permissions.
const (
	OrgRead          Permission = "org:read"
	OrgUpdate        Permission = "org:update"
	OrgDelete        Permission = "org:delete"
	MembersRead      Permission = "members:read"
	MembersInvite    Permission = "members:invite"
	MembersUpdate    Permission = "members:update"
	MembersRemove    Permission = "members:remove"
	ProjectsCreate   Permission = "projects:create"
	AuditRead        Permission = "audit:read"
	OrgProjectsRead  Permission = "org:projects:read" // see every project in the org
	ProjectsTransfer Permission = "projects:transfer"
)

// Project permissions.
const (
	ProjectRead        Permission = "project:read"
	ProjectUpdate      Permission = "project:update"
	ProjectDelete      Permission = "project:delete"
	ProjectSecretsRead Permission = "project:secrets:read"
	ProjectDataRead    Permission = "project:data:read"
	ProjectDataWrite   Permission = "project:data:write"
)

var orgMatrix = map[Role][]Permission{
	Owner: {OrgRead, OrgUpdate, OrgDelete, MembersRead, MembersInvite, MembersUpdate, MembersRemove,
		ProjectsCreate, AuditRead, OrgProjectsRead, ProjectsTransfer},
	Administrator: {OrgRead, MembersRead, MembersInvite, MembersUpdate, MembersRemove,
		ProjectsCreate, AuditRead, OrgProjectsRead},
	Developer: {OrgRead, MembersRead, OrgProjectsRead},
	ReadOnly:  {OrgRead, MembersRead, OrgProjectsRead},
	// No-access members can see that the organization exists (it is listed for
	// them, holding their project-scoped access) but nothing else.
	NoAccess: {OrgRead},
}

var projectMatrix = map[Role][]Permission{
	Owner:         {ProjectRead, ProjectUpdate, ProjectDelete, ProjectSecretsRead, ProjectDataRead, ProjectDataWrite},
	Administrator: {ProjectRead, ProjectUpdate, ProjectDelete, ProjectSecretsRead, ProjectDataRead, ProjectDataWrite},
	Developer:     {ProjectRead, ProjectSecretsRead, ProjectDataRead, ProjectDataWrite},
	ReadOnly:      {ProjectRead, ProjectDataRead},
	NoAccess:      {},
}

// OrgCan reports whether an organization role grants p.
func OrgCan(r Role, p Permission) bool { return slices.Contains(orgMatrix[r], p) }

// ProjectCan reports whether an effective project role grants p.
func ProjectCan(r Role, p Permission) bool { return slices.Contains(projectMatrix[r], p) }

// OrgPermissions lists what an organization role grants.
func OrgPermissions(r Role) []Permission { return slices.Clone(orgMatrix[r]) }

// ProjectPermissions lists what an effective project role grants.
func ProjectPermissions(r Role) []Permission { return slices.Clone(projectMatrix[r]) }

// EffectiveProjectRole combines a member's organization role with an optional
// project-scoped role. A project-scoped role always wins, so access can be
// narrowed or widened per project.
func EffectiveProjectRole(orgRole Role, projectRole *Role) Role {
	if projectRole != nil {
		return *projectRole
	}
	return orgRole
}

// CanAssign reports whether actor may give someone role r, or change or remove
// someone who currently has role r. Only Owners deal with Owners.
func CanAssign(actor, r Role) bool {
	if !OrgCan(actor, MembersUpdate) {
		return false
	}
	return r != Owner || actor == Owner
}

// ValidOrgRole reports whether r is an organization role.
func ValidOrgRole(r Role) bool { return slices.Contains(OrgRoles, r) }

// ValidProjectRole reports whether r can be granted on a single project.
func ValidProjectRole(r Role) bool { return slices.Contains(ProjectRoles, r) }
