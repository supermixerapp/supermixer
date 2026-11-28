import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

import { AccountLayout } from '@/components/layout/account-layout'
import { SettingsSection } from '@/components/layout/section'
import { Card } from '@/components/ui/card'
import { useProfile } from '@/lib/api/hooks'
import { uiConfigQuery } from '@/lib/api/queries'
import { FALLBACK_THEME, useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { localized, t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/_app/account/appearance')({
  component: AppearancePage,
})

function AppearancePage() {
  return (
    <AccountLayout title={t('account:appearance.appearance')}>
      <ThemeSection />
      <BrandSection />
    </AccountLayout>
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

const LABELS = localized((): Record<ThemePreference, string> => ({ dark: t('account:appearance.dark'), light: t('account:appearance.light'), system: t('account:appearance.system') }))

function ThemeSection() {
  const { preference, setPreference } = useTheme()
  const { data: profile } = useProfile()
  const { data: ui } = useQuery(uiConfigQuery)
  const fallback = ui?.default_theme ?? FALLBACK_THEME
  const options: { value: ThemePreference; label: string }[] = [
    { value: 'dark', label: t('account:appearance.dark') },
    { value: 'light', label: t('account:appearance.light') },
    { value: 'system', label: t('account:appearance.system') },
  ]
  return (
    <SettingsSection
      title={t('account:appearance.theme')}
      description={t('account:appearance.chooseHowSupermixerLooksToYou')}
    >
      <div role="radiogroup" aria-label={t('account:appearance.theme')} className="grid grid-cols-3 gap-3">
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
      {profile && (
        <p className="mt-3 text-xs text-foreground-lighter">
          {profile.theme
            ? t('account:appearance.savedOnYourAccount', { value: LABELS()[profile.theme] })
            : t('account:appearance.youHavenTChosenATheme', { value: LABELS()[fallback] })}
        </p>
      )}
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
      title={t('account:appearance.brandColour')}
      description={
        <>
          <Trans i18nKey="account:appearance.setByAppearanceBrandColorIn" components={{ code: <code className="font-mono text-xs" /> }} />
        </>
      }
    >
      <Card className="flex flex-col gap-5 p-5">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-md bg-primary-solid" />
          <div className="flex flex-col">
            <span className="text-sm text-foreground">
              {data?.brand_color === '#0019a8' ? t('account:appearance.piccadillyBlue') : t('account:appearance.customBrandColour')}
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
