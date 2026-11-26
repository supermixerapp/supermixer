/*
 * Stacks Supermixer created (Stage 4): status, progress and the docker
 * compose log.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/components/ui/toaster'
import { api, isApiError, unwrap, type Schemas } from '@/lib/api/client'
import { can } from '@/lib/api/hooks'

export type Stack = Schemas['Stack']
export type StackDetail = Schemas['StackDetail']
type Action = 'start' | 'stop' | 'restart'

/** Busy: something is changing, so poll fast. */
export const stackBusy = (s: Pick<Stack, 'status' | 'operation'> | null | undefined) =>
  !!s && (!!s.operation || s.status === 'provisioning' || s.status === 'deleting')

export const stackQuery = (ref: string) => ({
  queryKey: ['projects', ref, 'stack'],
  queryFn: () => unwrap(api.GET('/projects/{ref}/stack', { params: { path: { ref } } })),
  refetchInterval: (q: { state: { data?: StackDetail } }) =>
    stackBusy(q.state.data) ? 2000 : 15000,
})

/**
 * Calls onDone when the stack finishes rotating keys: one seen running, or
 * one this page started (await the returned function when the request
 * succeeds). A rotation on a paused stack can finish before the next poll,
 * so the second case waits for stack data fetched after the request was
 * accepted: a check already under way may predate it, so it's cancelled.
 * onDone must be stable (useCallback).
 */
export function useKeyRotationDone(ref: string, onDone: () => void, enabled = true) {
  const queryClient = useQueryClient()
  const stack = useQuery({ ...stackQuery(ref), enabled })
  const started = useRef(0)
  const last = useRef(stack.data?.operation)
  const operation = stack.data?.operation
  const { dataUpdatedAt } = stack
  useEffect(() => {
    const ours = started.current !== 0 && dataUpdatedAt > started.current && !operation
    if (ours || (last.current === 'rotating_keys' && !operation)) {
      started.current = 0
      onDone()
    }
    last.current = operation
  }, [operation, dataUpdatedAt, onDone])
  return async () => {
    const { queryKey } = stackQuery(ref)
    await queryClient.cancelQueries({ queryKey })
    started.current = Date.now()
    await queryClient.invalidateQueries({ queryKey })
  }
}

export const OPERATION_LABELS: Record<NonNullable<Stack['operation']>, string> = {
  starting: 'Starting…',
  stopping: 'Stopping…',
  restarting: 'Restarting…',
  deleting: 'Deleting…',
  updating: 'Updating functions…',
  backing_up: 'Backing up…',
  restoring: 'Restoring…',
  upgrading: 'Upgrading…',
  rotating_keys: 'Rotating keys…',
}

export const STACK_STATUS: Record<
  Stack['status'],
  { label: string; variant: 'success' | 'warning' | 'destructive' | 'default' }
> = {
  provisioning: { label: 'Creating…', variant: 'warning' },
  running: { label: 'Running', variant: 'success' },
  paused: { label: 'Paused', variant: 'default' },
  failed: { label: 'Failed', variant: 'destructive' },
  deleting: { label: 'Deleting…', variant: 'warning' },
}

export function StackBadge({ stack }: { stack: Pick<Stack, 'status' | 'operation'> }) {
  if (stack.operation) return <Badge variant="warning">{OPERATION_LABELS[stack.operation]}</Badge>
  const s = STACK_STATUS[stack.status]
  return <Badge variant={s.variant}>{s.label}</Badge>
}

/** Whether a project's health checks mean anything right now. Updating
 * functions only restarts the functions service; a backup stops nothing. */
export const stackUp = (stack: Pick<Stack, 'status' | 'operation'> | null | undefined) =>
  !stack ||
  (stack.status === 'running' &&
    (!stack.operation || stack.operation === 'updating' || stack.operation === 'backing_up'))

/** A stack's project was deleted: refresh the lists that still show it. */
export function useStackGone(error: Error | null) {
  const queryClient = useQueryClient()
  const gone = isApiError(error, 404)
  useEffect(() => {
    if (gone) void queryClient.invalidateQueries({ queryKey: ['projects'], exact: true })
  }, [gone, queryClient])
}

/** Keeps the project list in step when a stack's status changes. */
export function useStackSync(ref: string, stack: StackDetail | undefined) {
  const queryClient = useQueryClient()
  const key = stack ? `${stack.status}:${stack.operation ?? ''}` : ''
  const last = useRef(key)
  useEffect(() => {
    if (key && last.current && key !== last.current) {
      void queryClient.invalidateQueries({ queryKey: ['projects'], exact: true })
      void queryClient.invalidateQueries({ queryKey: ['projects', ref], exact: true })
      void queryClient.invalidateQueries({ queryKey: ['projects', ref, 'health'] })
    }
    last.current = key
  }, [key, ref, queryClient])
}

export function useStackAction(ref: string) {
  const queryClient = useQueryClient()
  return useMutation<StackDetail, Error, Action>({
    mutationFn: (action) =>
      unwrap(api.POST('/projects/{ref}/stack/{action}', { params: { path: { ref, action } } })),
    onSuccess: (data) => queryClient.setQueryData(['projects', ref, 'stack'], data),
    onError: (e) => toast.error(e.message),
  })
}

/** Which actions make sense now. */
export function stackActions(s: Pick<Stack, 'status' | 'operation'>): Action[] {
  if (s.operation || s.status === 'deleting' || s.status === 'provisioning') return []
  if (s.status === 'running') return ['restart', 'stop']
  return ['start']
}

export const ACTION_LABELS: Record<Action, string> = {
  start: 'Start',
  stop: 'Pause',
  restart: 'Restart',
}

/** The end of the docker compose output, kept scrolled to the bottom. */
export function StackLog({ log, className }: { log: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])
  return (
    <pre
      ref={ref}
      className={`max-h-80 overflow-auto rounded-md border bg-surface-100 p-3 font-mono text-xs whitespace-pre-wrap text-foreground-light ${className ?? ''}`}
    >
      {log || 'No output yet.'}
    </pre>
  )
}

/**
 * Shown on the project overview while a created stack isn't simply running:
 * being created, paused, failed or busy.
 */
export function StackProgress({ project }: { project: Schemas['Project'] }) {
  const stack = useQuery({ ...stackQuery(project.ref), enabled: !!project.stack })
  useStackSync(project.ref, stack.data)
  const act = useStackAction(project.ref)
  const s = stack.data
  if (!project.stack || !s || stackUp(s)) return null
  const allowed = can(project, 'project:update')
  const title =
    s.status === 'provisioning'
      ? 'Creating the stack'
      : s.operation
        ? OPERATION_LABELS[s.operation]
        : s.status === 'paused'
          ? 'This stack is paused'
          : s.status === 'failed'
            ? 'The stack needs attention'
            : 'Deleting the stack'
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-sm text-foreground">
            {title} <StackBadge stack={s} />
          </span>
          <span className="text-xs text-foreground-lighter">
            {s.status === 'provisioning'
              ? 'Supermixer is starting Supabase’s containers. The first stack can take several minutes while images download.'
              : s.status === 'paused'
                ? 'Its containers are stopped; data is kept. Start it to use the project again.'
                : s.status === 'failed'
                  ? 'The last operation didn’t finish. Read the output below, then try again.'
                  : 'Supermixer is working on the stack.'}
          </span>
        </div>
        {stackActions(s).includes('start') && (
          <PermissionButton
            allowed={allowed}
            action="start this stack"
            variant="primary"
            loading={act.isPending}
            onClick={() => act.mutate('start')}
          >
            {s.status === 'failed' ? 'Try again' : 'Start'}
          </PermissionButton>
        )}
      </div>
      {s.error && <Alert variant="destructive" title={s.error.split('\n')[0]!} />}
      {stack.isPending ? <Skeleton className="h-40" /> : <StackLog log={s.log} />}
    </Card>
  )
}
