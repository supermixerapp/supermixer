/*
 * Upgrading a stack Supermixer created to the Supabase version it bundles:
 * Settings › Infrastructure.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { SettingsSection } from '@/components/layout/section'
import { PermissionButton } from '@/components/permission-button'
import type { StackDetail } from '@/components/project/stack'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/toaster'
import { api, unwrap } from '@/lib/api/client'
import { t, Trans } from '@/lib/i18n'

const short = (commit: string) => commit.slice(0, 7)

function TemplateLink({ commit }: { commit: string }) {
  return (
    <a
      href={`https://github.com/supabase/supabase/tree/${commit}/docker`}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-xs text-foreground-light hover:text-foreground"
      title={commit}
    >
      {t('project:upgrade.supabaseDocker', { short: short(commit) })}
    </a>
  )
}

export function StackUpgrade({
  projectRef,
  stack,
  allowed,
}: {
  projectRef: string
  stack: StackDetail
  allowed: boolean
}) {
  const queryClient = useQueryClient()
  const upgrade = useQuery({
    queryKey: ['projects', projectRef, 'stack', 'upgrade'],
    queryFn: () =>
      unwrap(api.GET('/projects/{ref}/stack/upgrade', { params: { path: { ref: projectRef } } })),
  })
  // Look again when an upgrade (or anything else) finishes.
  const lastOperation = useRef(stack.operation)
  useEffect(() => {
    if (lastOperation.current && !stack.operation) void upgrade.refetch()
    lastOperation.current = stack.operation
  }, [stack.operation, upgrade])
  const [confirming, setConfirming] = useState(false)
  const run = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/projects/{ref}/stack/upgrade', { params: { path: { ref: projectRef } } })),
    onSuccess: () => toast.success(t('project:upgrade.upgradingTheStack')),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'stack'] })
    },
  })

  const u = upgrade.data
  const notReady =
    stack.status !== 'running'
      ? t('project:upgrade.startTheStackToUpgradeIt')
      : stack.operation
        ? t('project:upgrade.theStackIsBusyWaitFor')
        : null

  return (
    <SettingsSection
      title={t('project:upgrade.supabaseVersion')}
      description={t('project:upgrade.theVersionOfSupabaseSSelf')}
    >
      {upgrade.error ? (
        <Alert variant="destructive" title={upgrade.error.message} />
      ) : !u ? (
        <Skeleton className="h-24" />
      ) : (
        <Card className="flex flex-col divide-y text-sm">
          <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
            <span className="text-foreground-lighter">{t('project:upgrade.thisStack')}</span>
            <span className="col-span-2 flex items-center gap-2">
              <TemplateLink commit={u.current} />
              {u.up_to_date ? (
                <Badge variant="success">{t('project:upgrade.upToDate')}</Badge>
              ) : (
                <Badge variant="warning">{t('project:upgrade.upgradeAvailable')}</Badge>
              )}
            </span>
          </div>
          {!u.up_to_date && (
            <>
              <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
                <span className="text-foreground-lighter">{t('project:upgrade.bundled')}</span>
                <span className="col-span-2">
                  <TemplateLink commit={u.latest} />
                </span>
              </div>
              {u.images.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('project:upgrade.service')}</TableHead>
                      <TableHead>{t('project:upgrade.now')}</TableHead>
                      <TableHead>{t('project:upgrade.afterUpgrading')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {u.images.map((i) => (
                      <TableRow key={i.service}>
                        <TableCell className="font-mono text-xs text-foreground">{i.service}</TableCell>
                        <TableCell className="font-mono text-xs text-foreground-lighter">
                          {i.from || t('project:upgrade.newService')}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-foreground-light">
                          {i.to || t('project:upgrade.removed')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {u.new_keys.length > 0 && (
                <div className="px-5 py-3 text-xs text-foreground-lighter">
                  <Trans i18nKey="project:upgrade.newSettingsAddedToTheStack" values={{ join: u.new_keys.join(', ') }} components={{ span: <span className="font-mono text-foreground-light" /> }} />
                </div>
              )}
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <span className="text-xs text-foreground-lighter">
                  {u.blocked ??
                    t('project:upgrade.theDatabaseIsBackedUpFirst')}
                </span>
                {!u.blocked && (
                  <PermissionButton
                    allowed={allowed}
                    action={t('project:upgrade.upgradeThisStack')}
                    variant="primary"
                    disabled={!!notReady}
                    title={notReady ?? undefined}
                    loading={run.isPending}
                    onClick={() => setConfirming(true)}
                  >
                    {t('project:upgrade.upgrade')}
                  </PermissionButton>
                )}
              </div>
            </>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        variant="warning"
        title={t('project:upgrade.upgradeThisStack2')}
        description={
          u && (
            <>
              {t('project:upgrade.supermixerBacksTheDatabaseUpMoves', { short: short(u.latest) })}
            </>
          )
        }
        confirmLabel={t('project:upgrade.upgrade')}
        loading={run.isPending}
        onConfirm={() => run.mutate()}
      />
    </SettingsSection>
  )
}
