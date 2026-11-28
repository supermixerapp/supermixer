import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyField } from '@/components/ui/copy'
import { Skeleton } from '@/components/ui/skeleton'
import type { Schemas } from '@/lib/api/client'
import { can, useSelectedProject } from '@/lib/api/hooks'
import { apiKeysQuery } from '@/lib/api/queries'
import { t } from '@/lib/i18n'

type KeyId = Schemas['ApiKey']['id']

/** The server names and describes keys in English; the page says them in the user's language. */
function keyText(k: Schemas['ApiKey']): { name: string; description: string } {
  switch (k.id) {
    case 'publishable':
      return { name: t('project:apiKeyList.publishableName'), description: t('project:apiKeyList.publishableDescription') }
    case 'secret':
      return { name: t('project:apiKeyList.secretName'), description: t('project:apiKeyList.secretDescription') }
    case 'anon':
      return { name: k.name, description: t('project:apiKeyList.anonDescription') }
    case 'service_role':
      return { name: k.name, description: t('project:apiKeyList.serviceRoleDescription') }
    case 'jwt_secret':
      return { name: t('project:apiKeyList.jwtSecretName'), description: t('project:apiKeyList.jwtSecretDescription') }
    default:
      return { name: k.name, description: k.description }
  }
}

/**
 * Shows a project's keys. Public keys are always visible; secret ones stay
 * masked until revealed, which needs the project:secrets:read permission and
 * is recorded in the audit log.
 */
export function ApiKeyList({ projectRef, ids, title }: { projectRef: string; ids: KeyId[]; title: string }) {
  const project = useSelectedProject()
  const [reveal, setReveal] = useState(false)
  const keys = useQuery(apiKeysQuery(projectRef, reveal))
  const canReveal = can(project, 'project:secrets:read')
  const shown = (keys.data ?? []).filter((k) => ids.includes(k.id))

  return (
    <SettingsSection title={title}>
      <Card>
        {keys.isPending ? (
          <div className="p-4">
            <Skeleton className="h-16" />
          </div>
        ) : (
          <ul className="divide-y">
            {shown.map((k) => (
              <li key={k.id} className="flex flex-col gap-2 px-card py-4">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-foreground">{keyText(k).name}</span>
                  <Badge variant={k.secret ? 'warning' : 'default'}>
                    {k.secret ? t('project:apiKeyList.secretBadge') : t('project:apiKeyList.publicBadge')}
                  </Badge>
                </div>
                <p className="text-xs text-foreground-lighter">{keyText(k).description}</p>
                {!k.present ? (
                  <p className="text-sm text-foreground-lighter">{t('project:apiKeyList.notConfiguredForThisProject')}</p>
                ) : k.value ? (
                  <CopyField value={k.value} />
                ) : (
                  <CopyField
                    value=""
                    masked
                    actions={
                      <PermissionButton
                        allowed={canReveal}
                        action={t('project:apiKeyList.viewSecretApiKeys')}
                        variant="default"
                        loading={reveal && keys.isFetching}
                        onClick={() => setReveal(true)}
                      >
                        {t('project:apiKeyList.reveal')}
                      </PermissionButton>
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {reveal && (
        <Button variant="text" className="self-start" onClick={() => setReveal(false)}>
          {t('project:apiKeyList.hideSecrets')}
        </Button>
      )}
    </SettingsSection>
  )
}
