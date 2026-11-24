/*
 * Upgrading a stack Supermixer created to the Supabase version it bundles
 * (Stage 4.5): Settings › Infrastructure.
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
      supabase/docker @ {short(commit)}
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
    onSuccess: () => toast.success('Upgrading the stack'),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: ['projects', projectRef, 'stack'] })
    },
  })

  const u = upgrade.data
  const notReady =
    stack.status !== 'running'
      ? 'Start the stack to upgrade it'
      : stack.operation
        ? 'The stack is busy; wait for it to finish'
        : null

  return (
    <SettingsSection
      title="Supabase version"
      description="The version of Supabase's self-hosting files this stack runs, and the one this Supermixer server bundles."
    >
      {upgrade.error ? (
        <Alert variant="destructive" title={upgrade.error.message} />
      ) : !u ? (
        <Skeleton className="h-24" />
      ) : (
        <Card className="flex flex-col divide-y text-sm">
          <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
            <span className="text-foreground-lighter">This stack</span>
            <span className="col-span-2 flex items-center gap-2">
              <TemplateLink commit={u.current} />
              {u.up_to_date ? (
                <Badge variant="success">Up to date</Badge>
              ) : (
                <Badge variant="warning">Upgrade available</Badge>
              )}
            </span>
          </div>
          {!u.up_to_date && (
            <>
              <div className="grid grid-cols-3 items-center gap-4 px-5 py-3">
                <span className="text-foreground-lighter">Bundled</span>
                <span className="col-span-2">
                  <TemplateLink commit={u.latest} />
                </span>
              </div>
              {u.images.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Service</TableHead>
                      <TableHead>Now</TableHead>
                      <TableHead>After upgrading</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {u.images.map((i) => (
                      <TableRow key={i.service}>
                        <TableCell className="font-mono text-xs text-foreground">{i.service}</TableCell>
                        <TableCell className="font-mono text-xs text-foreground-lighter">
                          {i.from || 'new service'}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-foreground-light">
                          {i.to || 'removed'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {u.new_keys.length > 0 && (
                <div className="px-5 py-3 text-xs text-foreground-lighter">
                  New settings, added to the stack’s .env:{' '}
                  <span className="font-mono text-foreground-light">{u.new_keys.join(', ')}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <span className="text-xs text-foreground-lighter">
                  {u.blocked ??
                    'The database is backed up first. Services whose image changes restart; the rest keep running.'}
                </span>
                {!u.blocked && (
                  <PermissionButton
                    allowed={allowed}
                    action="upgrade this stack"
                    variant="primary"
                    disabled={!!notReady}
                    title={notReady ?? undefined}
                    loading={run.isPending}
                    onClick={() => setConfirming(true)}
                  >
                    Upgrade
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
        title="Upgrade this stack?"
        description={
          u && (
            <>
              Supermixer backs the database up, moves the stack to supabase/docker @ {short(u.latest)}, pulls
              the new images and restarts the services that change, which are briefly unavailable. If the
              stack doesn’t come up, it goes back to its current version.
            </>
          )
        }
        confirmLabel="Upgrade"
        loading={run.isPending}
        onConfirm={() => run.mutate()}
      />
    </SettingsSection>
  )
}
