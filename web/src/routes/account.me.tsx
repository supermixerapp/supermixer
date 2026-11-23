import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AppShell } from '@/components/layout/app-shell'
import { PageContainer, PageHeader } from '@/components/layout/page'
import { ProductMenu, WithProductMenu } from '@/components/layout/product-menu'
import { SettingsSection } from '@/components/layout/section'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { healthQuery, uiConfigQuery } from '@/lib/api/queries'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/account/me')({
  component: PreferencesPage,
})

function PreferencesPage() {
  return (
    <AppShell title="Account">
      <WithProductMenu
        menu={
          <ProductMenu
            title="Account settings"
            sections={[{ title: 'Account', links: [{ label: 'Preferences', to: '/account/me', active: true }] }]}
          />
        }
      >
        <PageHeader title="Preferences" size="small" />
        <PageContainer size="small" className="flex flex-col gap-10 pb-16">
          <AppearanceSection />
          <BrandSection />
          <SystemSection />
        </PageContainer>
      </WithProductMenu>
    </AppShell>
  )
}

/* Miniature app mock-ups for the theme picker, drawn with fixed colours because
   tokens resolve against the page's active theme. */
const PREVIEW = {
  dark: { bg: '#161616', panel: '#1f1f1f', line: '#2e2e2e', text: '#4d4d4d' },
  light: { bg: '#fcfcfc', panel: '#f3f3f3', line: '#dfdfdf', text: '#c7c7c7' },
}

function Mock({ mode, className }: { mode: 'dark' | 'light'; className?: string }) {
  const c = PREVIEW[mode]
  return (
    <svg viewBox="0 0 120 72" className={className} aria-hidden>
      <rect width="120" height="72" fill={c.bg} />
      <rect width="120" height="9" fill={c.panel} />
      <rect y="9" width="14" height="63" fill={c.panel} />
      <line x1="0" y1="9" x2="120" y2="9" stroke={c.line} />
      <line x1="14" y1="9" x2="14" y2="72" stroke={c.line} />
      <rect x="4" y="15" width="6" height="6" rx="1" fill="var(--primary-solid)" />
      <rect x="4" y="25" width="6" height="6" rx="1" fill={c.text} />
      <rect x="4" y="35" width="6" height="6" rx="1" fill={c.text} />
      <rect x="22" y="17" width="40" height="5" rx="1" fill={c.text} />
      <rect x="22" y="28" width="90" height="36" rx="2" fill={c.panel} stroke={c.line} />
    </svg>
  )
}

function AppearanceSection() {
  const { preference, setPreference } = useTheme()
  const options: { value: ThemePreference; label: string }[] = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
  ]
  return (
    <SettingsSection title="Appearance" description="Choose how Supermixer looks to you. Saved in this browser.">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={preference === o.value}
            onClick={() => setPreference(o.value)}
            className={cn(
              'group flex flex-col gap-2 rounded-panel text-left focus-ring',
              'text-sm text-foreground-light hover:text-foreground aria-checked:text-foreground'
            )}
          >
            <div
              className={cn(
                'overflow-hidden rounded-panel border-2 transition-colors',
                preference === o.value ? 'border-primary-bright' : 'border-transparent group-hover:border-strong'
              )}
            >
              {o.value === 'system' ? (
                <div className="relative">
                  <Mock mode="light" className="block w-full" />
                  <Mock mode="dark" className="absolute inset-0 block w-full [clip-path:polygon(50%_0,100%_0,100%_100%,50%_100%)]" />
                </div>
              ) : (
                <Mock mode={o.value} className="block w-full" />
              )}
            </div>
            {o.label}
          </button>
        ))}
      </div>
    </SettingsSection>
  )
}

function Swatch({ label, className }: { label: string; className: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn('h-10 rounded-md border', className)} />
      <span className="font-mono text-[11px] text-foreground-lighter">{label}</span>
    </div>
  )
}

function BrandSection() {
  const { data } = useQuery(uiConfigQuery)
  return (
    <SettingsSection
      title="Brand colour"
      description={
        <>
          Set by <code className="font-mono text-xs">BRAND_COLOR</code> in the server&apos;s .env file. Restart
          Supermixer to apply a change; every shade below is derived from it.
        </>
      }
    >
      <Card className="flex flex-col gap-5 p-5">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-md bg-primary-solid" />
          <div className="flex flex-col">
            <span className="text-sm text-foreground">
              {data?.brand_color === '#0019a8' ? 'Piccadilly blue' : 'Custom brand colour'}
            </span>
            <span className="font-mono text-xs text-foreground-lighter">{data?.brand_color ?? '…'}</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          <Swatch label="primary-solid" className="bg-primary-solid" />
          <Swatch label="primary" className="bg-primary" />
          <Swatch label="primary-bright" className="bg-primary-bright" />
          <Swatch label="brand-600" className="bg-brand-600" />
          <Swatch label="brand-500" className="bg-brand-500" />
          <Swatch label="brand-400" className="bg-brand-400" />
        </div>
      </Card>
    </SettingsSection>
  )
}

function SystemSection() {
  const { data, isPending, error } = useQuery(healthQuery)
  return (
    <SettingsSection title="System" description="Status of this Supermixer server and its database.">
      <Card>
        {error && !data ? (
          <dl className="text-sm">
            <Row label="Server">
              <Badge variant="destructive">unreachable</Badge>
            </Row>
            <p className="px-5 pb-3 text-xs text-foreground-lighter">{error.message}</p>
          </dl>
        ) : isPending || !data ? (
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <dl className="divide-y text-sm">
            <Row label="Server">
              <Badge variant={data.status === 'healthy' ? 'success' : 'destructive'}>{data.status}</Badge>
            </Row>
            <Row label="Version">
              <span className="font-mono text-xs">{data.version}</span>
            </Row>
            <Row label="Database">
              <Badge variant={data.database.status === 'healthy' ? 'success' : 'destructive'}>
                {data.database.status}
              </Badge>
            </Row>
            {data.database.schema_version != null && (
              <Row label="Schema version">
                <span className="font-mono text-xs">{data.database.schema_version}</span>
              </Row>
            )}
            {data.database.installed_at && (
              <Row label="Installed">{new Date(data.database.installed_at).toLocaleString()}</Row>
            )}
          </dl>
        )}
      </Card>
    </SettingsSection>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <dt className="text-foreground-light">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}
