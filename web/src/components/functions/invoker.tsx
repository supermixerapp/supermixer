/*
 * Calling an Edge Function by name: the whole page for stacks Supermixer
 * connects to, and the Test tab of a function on stacks it created.
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import { useCanChange } from '@/components/database/catalog-page'
import { PlayIcon } from '@/components/icons'
import { PermissionButton } from '@/components/permission-button'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { CodeBlock } from '@/components/ui/code-block'
import { FormField } from '@/components/ui/form-field'
import { Input, Textarea } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { gatewayRaw } from '@/lib/api/gateway'
import { isJsonObject } from '@/lib/pg/cron'
import { t } from '@/lib/i18n'

const METHODS = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'] as const
type Method = (typeof METHODS)[number]

const RECENT_KEY = (ref: string) => `supermixer.functions.recent.${ref}`

function loadRecent(ref: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY(ref)) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  } catch {
    return []
  }
}

function saveRecent(ref: string, names: string[]) {
  try {
    localStorage.setItem(RECENT_KEY(ref), JSON.stringify(names.slice(0, 10)))
  } catch {
    // Remembering names is a convenience only.
  }
}

interface Result {
  status: number
  statusText: string
  upstream401: boolean
  ms: number
  headers: [string, string][]
  body: string
}

/** A function name, and optionally a sub-path: hello, hello/items/1 */
const NAME = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.~-]+)*$/

/**
 * Calls a function through Supermixer's gateway proxy, as the service role,
 * and shows the response.
 */
export function FunctionInvoker({ projectRef: ref, initialName }: { projectRef: string; initialName?: string }) {
  const canInvoke = useCanChange()
  const [recent, setRecent] = useState(() => loadRecent(ref))
  const [name, setName] = useState(initialName ?? recent[0] ?? 'hello')
  const [method, setMethod] = useState<Method>('POST')
  const [query, setQuery] = useState('')
  const [headers, setHeaders] = useState('{"Content-Type": "application/json"}')
  const [body, setBody] = useState('{"name": "Supermixer"}')

  const fn = name.trim().replace(/^\/+|\/+$/g, '')
  const nameOk = NAME.test(fn)
  const headersOk = isJsonObject(headers)
  const invoke = useMutation<Result, Error>({
    mutationFn: async () => {
      const extra = headers.trim() ? (JSON.parse(headers) as Record<string, unknown>) : {}
      const sent = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)]))
      const path = `functions/v1/${fn.split('/').map(encodeURIComponent).join('/')}${query.trim() ? `?${query.trim().replace(/^\?/, '')}` : ''}`
      const start = performance.now()
      const res = await gatewayRaw(ref, path, { method, headers: sent, ...(method !== 'GET' && body !== '' && { body }) })
      const text = await res.text()
      return {
        // Supermixer passes a 401 from the stack on as 502 (so the app doesn't
        // take it for a lapsed session) and names the real status in a header.
        upstream401: res.headers.get('x-supermixer-upstream-status') === '401',
        status: res.headers.get('x-supermixer-upstream-status') === '401' ? 401 : res.status,
        statusText: res.headers.get('x-supermixer-upstream-status') === '401' ? t('functions:invoker.unauthorized') : res.statusText,
        ms: Math.round(performance.now() - start),
        headers: [...res.headers.entries()].filter(([k]) => !['content-security-policy', 'x-content-type-options'].includes(k)),
        body: text,
      }
    },
    onSuccess: () => {
      const next = [fn.split('/')[0]!, ...recent.filter((r) => r !== fn.split('/')[0])]
      setRecent(next)
      saveRecent(ref, next)
    },
  })
  const pretty = (text: string) => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <FormField label={t('functions:invoker.method')}>
            <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
              <SelectTrigger className="w-28" aria-label={t('functions:invoker.method')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="min-w-56 flex-1">
            <FormField label={t('functions:invoker.function')} htmlFor="fn-name" description={!nameOk && name ? <span className="text-destructive">{t('functions:invoker.aFunctionNameOptionallyFollowedBy')}</span> : undefined}>
              <Input id="fn-name" list="fn-recent" autoComplete="off" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="hello" />
            </FormField>
            <datalist id="fn-recent">
              {recent.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
          <div className="min-w-48 flex-1">
            <FormField label={t('functions:invoker.queryString')} htmlFor="fn-query">
              <Input id="fn-query" autoComplete="off" className="font-mono" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('functions:invoker.a1B2')} />
            </FormField>
          </div>
        </div>
        <FormField
          label={t('functions:invoker.headers')}
          htmlFor="fn-headers"
          description={headersOk ? t('functions:invoker.aJsonObjectSupermixerAddsThe') : <span className="text-destructive">{t('functions:invoker.mustBeAJsonObject')}</span>}
        >
          <Textarea id="fn-headers" rows={2} className="font-mono text-xs" value={headers} onChange={(e) => setHeaders(e.target.value)} />
        </FormField>
        {method !== 'GET' && (
          <FormField label={t('functions:invoker.body')} htmlFor="fn-body">
            <Textarea id="fn-body" rows={5} className="font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
          </FormField>
        )}
        <div className="flex items-center gap-3">
          <PermissionButton
            allowed={canInvoke}
            action={t('functions:invoker.callEdgeFunctions')}
            variant="primary"
            icon={<PlayIcon />}
            loading={invoke.isPending}
            disabled={!nameOk || !headersOk}
            onClick={() => invoke.mutate()}
          >
            {t('functions:invoker.sendRequest')}
          </PermissionButton>
          <span className="text-xs text-foreground-lighter">{t('functions:invoker.runsAsTheServiceRoleAnd')}</span>
        </div>
      </Card>
      {invoke.error && <Alert variant="destructive" title={invoke.error.message} />}
      {invoke.data && (
        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-3 text-sm">
            <Badge variant={invoke.data.status < 400 ? 'success' : 'destructive'}>
              {invoke.data.status} {invoke.data.statusText}
            </Badge>
            <span className="text-foreground-lighter">{t('functions:invoker.ms', { ms: invoke.data.ms })}</span>
            {invoke.data.upstream401 && (
              <span className="text-xs text-foreground-lighter">
                {t('functions:invoker.fromTheFunctionOrFromThe')}
              </span>
            )}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-foreground-light select-none">{t('functions:invoker.responseHeaders')}</summary>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono">
              {invoke.data.headers.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-foreground-lighter">{k}</dt>
                  <dd className="break-all text-foreground-light">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
          <CodeBlock code={pretty(invoke.data.body) || '(empty body)'} className="[&_pre]:max-h-[28rem]" />
        </Card>
      )}
    </div>
  )
}
