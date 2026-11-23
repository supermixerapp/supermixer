import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { AuthConfigPage, AuthSection } from '@/components/auth-config/kit'
import { AddIcon, DeleteIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export const Route = createFileRoute('/_app/project/$ref/auth/url-configuration')({
  component: UrlConfigurationPage,
})

function UrlConfigurationPage() {
  return (
    <AuthConfigPage title="URL Configuration" description="Where Auth sends users after they sign in, confirm their email or reset their password.">
      {(ctx) => (
        <>
          <AuthSection
            ctx={ctx}
            title="Site URL"
            description="The default redirect URL, used when a request names none or one that isn't allowed. Also {{ .SiteURL }} in email templates."
            fields={[{ name: 'site_url', label: 'Site URL', type: 'url', default: 'http://localhost:3000' }]}
          />
          <AuthSection
            ctx={ctx}
            title="Redirect URLs"
            description="Other URLs Auth may redirect to, such as preview deploys or a mobile app's deep link. Wildcards work: * matches within a path segment, ** across segments."
            fields={[]}
          >
            {(d) => <UrlList value={(d.get('uri_allow_list') as string | null) ?? ''} onChange={(v) => d.set('uri_allow_list', v)} disabled={!ctx.canChange} />}
          </AuthSection>
        </>
      )}
    </AuthConfigPage>
  )
}

function UrlList({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const urls = value.split(',').map((u) => u.trim()).filter(Boolean)
  const [adding, setAdding] = useState('')
  const problem = adding.trim() && !/^(\*|[a-z][a-z0-9+.-]*:\/\/)\S*$/i.test(adding.trim()) ? 'Start with a scheme, like https:// or myapp://' : null
  const add = () => {
    const u = adding.trim()
    if (!u || problem || urls.includes(u)) return
    onChange([...urls, u].join(','))
    setAdding('')
  }
  return (
    <div className="flex flex-col gap-3">
      {urls.length === 0 ? (
        <p className="text-sm text-foreground-lighter">No redirect URLs yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {urls.map((u) => (
            <li key={u} className="flex items-center justify-between gap-3 px-3 py-2 font-mono text-xs text-foreground">
              <span className="break-all">{u}</span>
              <Button
                type="button"
                variant="text"
                size="tiny"
                aria-label={`Remove ${u}`}
                icon={<DeleteIcon />}
                disabled={disabled}
                onClick={() => onChange(urls.filter((x) => x !== u).join(','))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <Input
            aria-label="Redirect URL to add"
            className="font-mono text-xs"
            placeholder="https://app.example.com/**"
            value={adding}
            disabled={disabled}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
          <Button type="button" variant="default" icon={<AddIcon />} disabled={disabled || !adding.trim() || !!problem} onClick={add}>
            Add URL
          </Button>
        </div>
        {problem && <span className="text-xs text-destructive">{problem}</span>}
      </div>
    </div>
  )
}
