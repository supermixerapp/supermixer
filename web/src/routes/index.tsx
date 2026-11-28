/*
 * The homepage: what Supermixer is, for anyone who opens the site. The
 * navbar is the app's own; signed in, it has the Dashboard button (the
 * usual landing after sign-in, /dashboard), search and the account menu.
 * The global notice shows to everyone.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import {
  AppIcon,
  DatabaseIcon,
  LockIcon,
  ProjectsIcon,
  TableEditorIcon,
  TeamIcon,
  VerifiedUserIcon,
} from '@/components/icons'
import type { Icon } from '@/components/icon'
import { CommandMenuTrigger } from '@/components/layout/command-menu'
import { GlobalNotice } from '@/components/layout/global-notice'
import { ThemeSync } from '@/components/layout/theme-sync'
import { LanguageMenu, LanguageSync } from '@/components/layout/language-menu'
import { UserDropdown } from '@/components/layout/user-dropdown'
import { Button } from '@/components/ui/button'
import { profileQuery } from '@/lib/api/queries'
import { localized, t, Trans } from '@/lib/i18n'

export const Route = createFileRoute('/')({
  component: HomePage,
})

const FEATURES = localized((): { icon: Icon; title: string; text: string }[] => [
  {
    icon: ProjectsIcon,
    title: t('home:home.everyProjectOnOneScreen'),
    text: t('home:home.connectTheSupabaseProjectsYouAlready'),
  },
  {
    icon: DatabaseIcon,
    title: t('home:home.asManyProjectsAsYouNeed'),
    text: t('home:home.itRunsOnYourOwnServers'),
  },
  {
    icon: LockIcon,
    title: t('home:home.staysOnYourServers'),
    text: t('home:home.supermixerRunsNextToYourProjects'),
  },
  {
    icon: TeamIcon,
    title: t('home:home.yourTeamYourRules'),
    text: t('home:home.invitePeopleAndChooseWhatEach'),
  },
  {
    icon: VerifiedUserIcon,
    title: t('home:home.safeSignIn'),
    text: t('home:home.twoStepSignInSingleSign'),
  },
  {
    icon: TableEditorIcon,
    title: t('home:home.theToolsYouKnow'),
    text: t('home:home.editTablesRunSqlManageUsers'),
  },
])

const STEPS = localized((): { title: string; text: string }[] => [
  { title: t('home:home.installSupermixer'), text: t('home:home.runItOnYourOwnServer') },
  {
    title: t('home:home.addYourProjects'),
    text: t('home:home.connectTheSupabaseProjectsYouHave'),
  },
  { title: t('home:home.inviteYourTeam'), text: t('home:home.sendEachPersonAnInvitationAnd') },
])

function HomePage() {
  // Signed out is a normal state here, not an error worth retrying.
  const me = useQuery({ ...profileQuery, retry: false })
  const signedIn = !!me.data
  // Only the first check hides the navbar's buttons. Hovering a link
  // preloads its page, and the sign-in page checks the profile again; that
  // re-check mustn't hide the buttons (they'd flicker, and miss clicks).
  const checking = me.dataUpdatedAt === 0 && me.errorUpdatedAt === 0
  return (
    <div className="flex min-h-full flex-col bg-dash-sidebar">
      {signedIn && <ThemeSync />}
      {signedIn && <LanguageSync />}
      <GlobalNotice />
      <SiteHeader signedIn={signedIn} checking={checking} />
      <main className="flex-1">
        <Hero signedIn={signedIn} />
        <Features />
        <Steps />
        <Closing signedIn={signedIn} />
      </main>
      <SiteFooter signedIn={signedIn} />
    </div>
  )
}

/** The app's navbar: logo, then Sign in, or Dashboard, search and the account menu. */
function SiteHeader({ signedIn, checking }: { signedIn: boolean; checking: boolean }) {
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center border-b bg-dash-sidebar">
      <div className="flex h-full flex-1 items-center justify-between gap-x-8 pr-3 pl-4">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-1.5 rounded-sm text-primary focus-ring"
        >
          <AppIcon size={22} />
          <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
            Supermixer
          </span>
        </Link>
        <div className="flex items-center gap-x-2">
          {checking ? null : signedIn ? (
            <>
              <CommandMenuTrigger />
              <Button asChild size="tiny" variant="primary">
                <Link to="/dashboard">{t('home:home.dashboard')}</Link>
              </Button>
              <LanguageMenu saveToAccount />
              <UserDropdown />
            </>
          ) : (
            <>
              <LanguageMenu />
              <Button asChild size="tiny" variant="primary">
                <Link to="/sign-in">{t('home:home.signIn')}</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  )
}

function Section({
  id,
  children,
  className,
}: {
  id?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} className={`border-b ${className ?? ''}`}>
      <div className="mx-auto w-full max-w-6xl px-6 lg:px-10">{children}</div>
    </section>
  )
}

function MainAction({ signedIn }: { signedIn: boolean }) {
  return (
    <Button asChild size="medium" variant="primary">
      {signedIn ? <Link to="/dashboard">{t('home:home.goToDashboard')}</Link> : <Link to="/sign-in">{t('home:home.signIn')}</Link>}
    </Button>
  )
}

function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="relative overflow-hidden border-b">
      {/* A soft glow of the brand colour behind the headline. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[480px] bg-[radial-gradient(ellipse_at_center,var(--primary)_0%,transparent_65%)] opacity-[0.14]"
      />
      <div className="relative mx-auto flex w-full max-w-4xl flex-col items-center px-6 py-24 text-center sm:py-32">
        <p className="mb-5 text-sm text-foreground-lighter">
          {t('home:home.forTeamsThatRunSupabaseThemselves')}
        </p>
        <h1 className="font-heading text-4xl leading-[1.1] font-semibold tracking-tight text-balance text-foreground sm:text-5xl lg:text-6xl">
          <Trans i18nKey="home:home.allYourSupabaseProjectsInOne" components={{ br: <br />, span: <span className="text-primary" /> }} />
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-foreground-light sm:text-lg">
          <Trans i18nKey="home:home.runUnlimitedSupabaseOnYourOwn" components={{ brushring: <BrushRing>{null}</BrushRing> }} />
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <MainAction signedIn={signedIn} />
          <Button asChild size="medium" variant="default">
            <a href="#features">{t('home:home.seeWhatItDoes')}</a>
          </Button>
        </div>
        <p className="mt-6 text-xs text-foreground-lighter">
          {t('home:home.freeAndOpenSourceUnderThe')}
        </p>
      </div>
    </section>
  )
}

/**
 * A word ringed with a yellow brush: one solid stroke all the way round,
 * closing with a small overlap, slightly uneven like a hand's. Its outline
 * was generated (an ellipse turned a little more than once, widened by a
 * varying amount), so it's a filled shape rather than a pen line.
 */
function BrushRing({ children }: { children: ReactNode }) {
  return (
    <span className="relative mx-3.5 inline-block whitespace-nowrap text-foreground">
      <svg
        aria-hidden
        viewBox="0 0 220 72"
        preserveAspectRatio="none"
        className="pointer-events-none absolute -inset-x-[0.95em] -inset-y-[0.36em] h-[calc(100%+0.72em)] w-[calc(100%+1.9em)] -rotate-2 overflow-visible text-[#ffd43b]"
      >
        <path
          fill="currentColor"
          d="M21.5 27.2 L23.0 24.7 L25.2 22.6 L27.8 20.7 L30.7 18.8 L34.0 17.0 L37.7 15.3 L41.6 13.7 L45.9 12.1 L50.6 10.9 L55.6 9.8 L60.8 8.8 L66.4 7.9 L72.2 7.1 L78.2 6.4 L84.3 5.9 L90.6 5.4 L97.0 5.1 L103.5 5.0 L109.9 5.0 L116.3 5.1 L122.7 5.3 L129.0 5.6 L135.1 6.1 L141.1 6.7 L146.9 7.3 L152.5 8.1 L157.9 8.9 L163.1 9.8 L168.2 10.8 L173.0 11.8 L177.7 13.0 L182.1 14.1 L186.3 15.4 L190.4 16.7 L194.2 18.1 L197.9 19.6 L201.2 21.2 L204.4 22.9 L207.3 24.8 L209.8 26.9 L212.1 29.2 L213.8 31.8 L215.0 34.6 L215.4 37.6 L215.1 40.5 L214.1 43.2 L212.5 45.7 L210.5 47.9 L208.0 50.0 L205.1 51.9 L201.8 53.7 L198.1 55.4 L194.0 56.9 L189.7 58.4 L185.0 59.7 L180.0 60.9 L174.9 62.1 L169.5 63.1 L164.0 64.0 L158.3 64.8 L152.5 65.6 L146.5 66.2 L140.5 66.7 L134.4 67.2 L128.3 67.6 L122.0 67.9 L115.7 68.1 L109.4 68.2 L103.0 68.2 L96.5 68.1 L90.1 67.9 L83.7 67.6 L77.3 67.2 L71.0 66.6 L64.8 66.0 L58.7 65.2 L52.8 64.2 L47.2 63.2 L41.8 62.0 L36.7 60.8 L32.0 59.4 L27.6 57.9 L23.7 56.3 L20.1 54.6 L16.9 52.8 L14.2 50.9 L11.9 49.0 L9.9 46.9 L8.4 44.6 L7.3 42.2 L6.7 39.7 L6.5 37.0 L7.0 34.2 L8.0 31.6 L9.5 29.2 L11.2 27.0 L13.3 25.0 L15.6 23.2 L18.3 21.6 L21.2 20.1 L24.3 18.7 L27.8 17.3 L31.5 16.1 L35.5 14.9 L39.9 13.7 L44.5 12.7 L49.5 11.8 L54.8 11.0 L60.3 10.5 L66.2 10.4 L66.2 10.4 L60.6 12.2 L55.2 13.6 L50.1 15.1 L45.4 16.6 L41.0 18.1 L37.0 19.7 L33.3 21.4 L29.9 23.0 L27.0 24.7 L24.4 26.4 L22.2 28.1 L20.3 29.7 L18.7 31.2 L17.4 32.5 L16.5 33.7 L15.9 34.7 L15.4 35.5 L15.1 36.3 L15.0 37.0 L15.0 37.9 L15.4 39.0 L16.2 40.3 L17.4 41.7 L19.2 43.1 L21.4 44.5 L24.1 45.9 L27.2 47.3 L30.8 48.7 L34.9 49.9 L39.3 51.1 L44.1 52.2 L49.2 53.2 L54.7 54.1 L60.3 54.9 L66.2 55.5 L72.2 56.1 L78.3 56.5 L84.5 56.8 L90.7 57.1 L97.0 57.2 L103.2 57.2 L109.4 57.1 L115.5 57.0 L121.7 56.7 L127.7 56.4 L133.7 56.0 L139.5 55.5 L145.3 55.0 L151.0 54.4 L156.6 53.7 L162.0 52.9 L167.3 52.0 L172.3 51.1 L177.2 50.1 L181.8 49.0 L186.1 47.8 L190.0 46.6 L193.6 45.3 L196.7 43.9 L199.4 42.6 L201.6 41.2 L203.2 39.9 L204.4 38.7 L205.0 37.7 L205.2 36.9 L205.0 36.3 L204.7 35.8 L204.1 35.1 L203.3 34.3 L202.1 33.3 L200.5 32.1 L198.5 30.8 L196.1 29.5 L193.4 28.1 L190.3 26.8 L187.0 25.4 L183.3 24.1 L179.5 22.9 L175.3 21.7 L171.0 20.5 L166.4 19.4 L161.6 18.4 L156.6 17.4 L151.4 16.5 L145.9 15.7 L140.3 14.9 L134.5 14.3 L128.5 13.8 L122.4 13.4 L116.2 13.1 L109.9 12.9 L103.6 12.9 L97.3 13.0 L91.0 13.2 L84.9 13.6 L78.9 14.1 L73.0 14.8 L67.4 15.5 L62.0 16.4 L56.9 17.4 L52.1 18.5 L47.7 19.6 L43.4 20.5 L39.5 21.5 L35.9 22.5 L32.6 23.6 L29.6 24.6 L26.8 25.7 L24.2 26.6 L21.5 27.2 Z"
        />
      </svg>
      <span className="relative">{children}</span>
    </span>
  )
}

function Features() {
  return (
    <Section id="features" className="scroll-mt-12">
      <div className="py-20 sm:py-24">
        <div className="max-w-2xl">
          <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {t('home:home.whatYouCanDoWithIt')}
          </h2>
          <p className="mt-3 text-foreground-light">
            {t('home:home.aManagementPlaneForSelfHosted')}
          </p>
        </div>
        <div className="mt-14 grid gap-x-12 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES().map((f) => (
            <div key={f.title} className="flex flex-col gap-3">
              <f.icon size={24} className="text-primary" />
              <h3 className="font-heading text-base font-semibold text-foreground">{f.title}</h3>
              <p className="text-sm leading-relaxed text-foreground-light">{f.text}</p>
            </div>
          ))}
        </div>
      </div>
    </Section>
  )
}

function Steps() {
  return (
    <Section>
      <div className="py-20 sm:py-24">
        <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('home:home.upAndRunningInThreeSteps')}
        </h2>
        <ol className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-8">
          {STEPS().map((s, i) => (
            <li key={s.title} className="relative flex flex-col gap-3">
              {/* The line joining the steps, from this number to the next. */}
              {i < STEPS().length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-4 left-10 hidden h-px w-[calc(100%-2rem)] bg-border sm:block"
                />
              )}
              <span className="relative flex size-8 items-center justify-center rounded-full border border-strong bg-dash-sidebar font-mono text-sm text-foreground">
                {i + 1}
              </span>
              <h3 className="font-heading text-base font-semibold text-foreground">{s.title}</h3>
              <p className="text-sm leading-relaxed text-foreground-light">{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </Section>
  )
}

function Closing({ signedIn }: { signedIn: boolean }) {
  return (
    <Section>
      <div className="flex flex-col items-center py-20 text-center sm:py-28">
        <h2 className="font-heading text-3xl font-semibold tracking-tight text-balance text-foreground sm:text-4xl">
          {t('home:home.bringYourProjectsTogether')}
        </h2>
        <p className="mt-4 max-w-xl text-foreground-light">
          {signedIn
            ? t('home:home.yourOrganizationsAndProjectsAreWaiting')
            : t('home:home.signInWithTheAccountYour')}
        </p>
        <div className="mt-8">
          <MainAction signedIn={signedIn} />
        </div>
      </div>
    </Section>
  )
}

function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-12 lg:px-10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex flex-col gap-2">
            <Link
              to="/"
              className="flex items-center gap-1.5 self-start rounded-sm text-primary focus-ring"
            >
              <AppIcon size={22} />
              <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
                Supermixer
              </span>
            </Link>
            <p className="text-sm text-foreground-lighter">{t('home:home.aDashboardForSelfHostedSupabase')}</p>
          </div>
          <nav aria-label={t('home:home.footer')} className="flex gap-6 text-sm">
            {signedIn ? (
              <Link to="/dashboard" className="text-foreground-light hover:text-foreground">
                {t('home:home.dashboard')}
              </Link>
            ) : (
              <Link to="/sign-in" className="text-foreground-light hover:text-foreground">
                {t('home:home.signIn')}
              </Link>
            )}
            <a href="#features" className="text-foreground-light hover:text-foreground">
              {t('home:home.features')}
            </a>
          </nav>
        </div>
        <div className="flex flex-col gap-1 border-t pt-6 text-xs text-foreground-lighter">
          <p>{t('home:home.n2026TheSupermixerAuthorsReleasedUnder')}</p>
          <p>
            {t('home:home.supabaseIsATrademarkOfSupabase')}
          </p>
        </div>
      </div>
    </footer>
  )
}
