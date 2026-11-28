import type { Schemas } from './api/client'
import { localized, t } from '@/lib/i18n'

export type OrgRole = Schemas['OrgRole']
export type ProjectRole = Schemas['ProjectRole']

export const ORG_ROLES = localized((): { value: OrgRole; label: string; description: string }[] => [
  { value: 'owner', label: t('common:roles.owner'), description: t('common:roles.fullAccessIncludingOrganizationSettingsAnd') },
  {
    value: 'administrator',
    label: t('common:roles.administrator'),
    description: t('common:roles.fullAccessExceptOrganizationSettingsTransferring'),
  },
  {
    value: 'developer',
    label: t('common:roles.developer'),
    description: t('common:roles.worksWithProjectDataAndKeys'),
  },
  { value: 'read_only', label: t('common:roles.readOnly'), description: t('common:roles.canViewEverythingExceptSecretApi') },
  { value: 'no_access', label: t('common:roles.noAccess'), description: t('common:roles.seesOnlyTheProjectsGivenTo') },
])

export const PROJECT_ROLES = localized((): { value: ProjectRole; label: string }[] => [
  { value: 'administrator', label: t('common:roles.administrator') },
  { value: 'developer', label: t('common:roles.developer') },
  { value: 'read_only', label: t('common:roles.readOnly') },
])

export function roleLabel(role: string) {
  return ORG_ROLES().find((r) => r.value === role)?.label ?? role
}
