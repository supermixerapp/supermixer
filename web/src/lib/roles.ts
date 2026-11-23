import type { Schemas } from './api/client'

export type OrgRole = Schemas['OrgRole']
export type ProjectRole = Schemas['ProjectRole']

export const ORG_ROLES: { value: OrgRole; label: string; description: string }[] = [
  { value: 'owner', label: 'Owner', description: 'Full access, including organization settings and managing Owners.' },
  {
    value: 'administrator',
    label: 'Administrator',
    description: 'Full access except organization settings, transferring projects out and managing Owners.',
  },
  {
    value: 'developer',
    label: 'Developer',
    description: 'Works with project data and keys, and deploys Edge Functions; cannot change settings.',
  },
  { value: 'read_only', label: 'Read-only', description: 'Can view everything except secret API keys.' },
  { value: 'no_access', label: 'No access', description: 'Sees only the projects given to them below.' },
]

export const PROJECT_ROLES: { value: ProjectRole; label: string }[] = [
  { value: 'administrator', label: 'Administrator' },
  { value: 'developer', label: 'Developer' },
  { value: 'read_only', label: 'Read-only' },
]

export function roleLabel(role: string) {
  return ORG_ROLES.find((r) => r.value === role)?.label ?? role
}
