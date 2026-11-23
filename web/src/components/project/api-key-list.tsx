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

type KeyId = Schemas['ApiKey']['id']

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
                  <span className="font-mono text-sm text-foreground">{k.name}</span>
                  <Badge variant={k.secret ? 'warning' : 'default'}>{k.secret ? 'secret' : 'public'}</Badge>
                </div>
                <p className="text-xs text-foreground-lighter">{k.description}</p>
                {!k.present ? (
                  <p className="text-sm text-foreground-lighter">Not configured for this project.</p>
                ) : k.value ? (
                  <CopyField value={k.value} />
                ) : (
                  <CopyField
                    value=""
                    masked
                    actions={
                      <PermissionButton
                        allowed={canReveal}
                        action="view secret API keys"
                        variant="default"
                        loading={reveal && keys.isFetching}
                        onClick={() => setReveal(true)}
                      >
                        Reveal
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
          Hide secrets
        </Button>
      )}
    </SettingsSection>
  )
}
