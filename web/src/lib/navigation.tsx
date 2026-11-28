/*
 * Navigation structure, mirroring Supabase Studio's sidebar
 * (NavigationBar.utils.tsx) and product menus (DatabaseMenu.utils.tsx,
 * AuthLayout.utils.ts, SettingsMenu.utils.tsx, …) as of 2026-11.
 *
 * `stage` marks when a page is built. Pages whose stage is later than the
 * current one show a "Coming soon" placeholder.
 */
import {
  AdvisorsIcon,
  AuthIcon,
  DatabaseIcon,
  EdgeFunctionsIcon,
  HomeIcon,
  IntegrationsIcon,
  LogsIcon,
  ObservabilityIcon,
  ProjectsIcon,
  RealtimeIcon,
  SettingsIcon,
  SqlEditorIcon,
  StorageIcon,
  TableEditorIcon,
  TeamIcon,
  UsageIcon,
} from '@/components/icons'
import type { Icon } from '@/components/icon'
import { localized, t } from '@/lib/i18n'

/** The implementation stage Supermixer is currently at. */
export const CURRENT_STAGE = 5

export interface NavRoute {
  key: string
  label: string
  icon: Icon
  /** Path relative to /project/$ref or /org/$slug; '' is the index page. */
  path: string
  stage: number
}

/** Project sidebar, in Studio's groups: home+tools, products, other, settings. */
export const projectNavGroups = localized((): NavRoute[][] => [
  [
    { key: 'home', label: t('common:navigation.projectOverview'), icon: HomeIcon, path: '', stage: 1 },
    { key: 'editor', label: t('common:navigation.tableEditor'), icon: TableEditorIcon, path: 'editor', stage: 2 },
    { key: 'sql', label: t('common:navigation.sqlEditor'), icon: SqlEditorIcon, path: 'sql', stage: 2 },
  ],
  [
    { key: 'database', label: t('common:navigation.database'), icon: DatabaseIcon, path: 'database/tables', stage: 2 },
    { key: 'auth', label: t('common:navigation.authentication'), icon: AuthIcon, path: 'auth/users', stage: 2 },
    { key: 'storage', label: t('common:navigation.storage'), icon: StorageIcon, path: 'storage/buckets', stage: 2 },
    { key: 'functions', label: t('common:navigation.edgeFunctions'), icon: EdgeFunctionsIcon, path: 'functions', stage: 3 },
    { key: 'realtime', label: t('common:navigation.realtime'), icon: RealtimeIcon, path: 'realtime/inspector', stage: 3 },
  ],
  [
    { key: 'advisors', label: t('common:navigation.advisors'), icon: AdvisorsIcon, path: 'advisors/security', stage: 3 },
    { key: 'observability', label: t('common:navigation.observability'), icon: ObservabilityIcon, path: 'observability', stage: 3 },
    { key: 'logs', label: t('common:navigation.logs'), icon: LogsIcon, path: 'logs/explorer', stage: 3 },
    { key: 'integrations', label: t('common:navigation.integrations'), icon: IntegrationsIcon, path: 'integrations', stage: 3 },
  ],
  [{ key: 'settings', label: t('common:navigation.projectSettings'), icon: SettingsIcon, path: 'settings/general', stage: 1 }],
])

/** Organization sidebar (Studio's OrganizationLinks, minus Billing). */
export const orgNav = localized((): NavRoute[] => [
  { key: 'projects', label: t('common:navigation.projects'), icon: ProjectsIcon, path: '', stage: 1 },
  { key: 'team', label: t('common:navigation.team'), icon: TeamIcon, path: 'team', stage: 1 },
  { key: 'integrations', label: t('common:navigation.integrations'), icon: IntegrationsIcon, path: 'integrations', stage: 5 },
  { key: 'usage', label: t('common:navigation.usage'), icon: UsageIcon, path: 'usage', stage: 3 },
  { key: 'settings', label: t('common:navigation.organizationSettings'), icon: SettingsIcon, path: 'general', stage: 1 },
])

export interface ProductMenuItem {
  label: string
  /** Path relative to /project/$ref */
  path: string
  stage: number
  badge?: string
  /** Not built yet, nor scheduled: its page says "Coming soon". */
  soon?: boolean
}

export interface ProductMenuGroup {
  title: string
  items: ProductMenuItem[]
}

export interface ProductMenu {
  title: string
  groups: ProductMenuGroup[]
}

/** Second-level menus, keyed by the first path segment under /project/$ref. */
export const productMenus = localized((): Record<string, ProductMenu> => ({
  database: {
    title: t('common:navigation.database'),
    groups: [
      {
        title: t('common:navigation.databaseManagement'),
        items: [
          { label: t('common:navigation.schemaVisualizer'), path: 'database/schemas', stage: 2 },
          { label: t('common:navigation.tables'), path: 'database/tables', stage: 2 },
          { label: t('common:navigation.functions'), path: 'database/functions', stage: 2 },
          { label: t('common:navigation.triggers'), path: 'database/triggers', stage: 2 },
          { label: t('common:navigation.enumeratedTypes'), path: 'database/types', stage: 2 },
          { label: t('common:navigation.extensions'), path: 'database/extensions', stage: 2 },
          { label: t('common:navigation.indexes'), path: 'database/indexes', stage: 2 },
          { label: t('common:navigation.publications'), path: 'database/publications', stage: 2 },
        ],
      },
      {
        title: t('common:navigation.accessControl'),
        items: [
          { label: t('common:navigation.policies'), path: 'database/policies', stage: 2 },
          { label: t('common:navigation.roles'), path: 'database/roles', stage: 2 },
          { label: t('common:navigation.columnPrivileges'), path: 'database/column-privileges', stage: 2 },
        ],
      },
      {
        title: t('common:navigation.configuration'),
        items: [{ label: t('common:navigation.settings'), path: 'database/settings', stage: 2 }],
      },
      {
        title: t('common:navigation.platform'),
        items: [
          { label: t('common:navigation.backups'), path: 'database/backups', stage: 4 },
          { label: t('common:navigation.migrations'), path: 'database/migrations', stage: 2 },
        ],
      },
    ],
  },
  auth: {
    title: t('common:navigation.authentication'),
    groups: [
      {
        title: t('common:navigation.manage'),
        items: [{ label: t('common:navigation.users'), path: 'auth/users', stage: 2 }],
      },
      {
        title: t('common:navigation.notifications'),
        items: [{ label: t('common:navigation.emails'), path: 'auth/templates', stage: 4 }],
      },
      {
        title: t('common:navigation.configuration'),
        items: [
          { label: t('common:navigation.policies'), path: 'auth/policies', stage: 2 },
          { label: t('common:navigation.signInProviders'), path: 'auth/providers', stage: 4 },
          { label: t('common:navigation.sessions'), path: 'auth/sessions', stage: 4 },
          { label: t('common:navigation.rateLimits'), path: 'auth/rate-limits', stage: 4 },
          { label: t('common:navigation.multiFactor'), path: 'auth/mfa', stage: 4 },
          { label: t('common:navigation.urlConfiguration'), path: 'auth/url-configuration', stage: 4 },
          { label: t('common:navigation.attackProtection'), path: 'auth/protection', stage: 4 },
          { label: t('common:navigation.authHooks'), path: 'auth/hooks', stage: 4 },
          { label: t('common:navigation.auditLogs'), path: 'auth/audit-logs', stage: 3 },
        ],
      },
    ],
  },
  functions: {
    title: t('common:navigation.edgeFunctions'),
    groups: [
      {
        title: t('common:navigation.manage'),
        items: [
          { label: t('common:navigation.functions'), path: 'functions', stage: 3 },
          { label: t('common:navigation.secrets'), path: 'functions/secrets', stage: 4 },
        ],
      },
    ],
  },
  storage: {
    title: t('common:navigation.storage'),
    groups: [
      {
        title: t('common:navigation.manage'),
        items: [
          { label: t('common:navigation.buckets'), path: 'storage/buckets', stage: 2 },
          { label: t('common:navigation.policies'), path: 'storage/policies', stage: 2 },
        ],
      },
      {
        title: t('common:navigation.configuration'),
        items: [
          { label: t('common:navigation.settings'), path: 'storage/settings', stage: 4 },
          { label: t('common:navigation.s3Connection'), path: 'storage/s3', stage: 4 },
        ],
      },
    ],
  },
  realtime: {
    title: t('common:navigation.realtime'),
    groups: [
      {
        title: t('common:navigation.tools'),
        items: [{ label: t('common:navigation.inspector'), path: 'realtime/inspector', stage: 3 }],
      },
      {
        title: t('common:navigation.configuration'),
        items: [{ label: t('common:navigation.policies'), path: 'realtime/policies', stage: 3 }],
      },
    ],
  },
  advisors: {
    title: t('common:navigation.advisors'),
    groups: [
      {
        title: t('common:navigation.advisors'),
        items: [
          { label: t('common:navigation.securityAdvisor'), path: 'advisors/security', stage: 3 },
          { label: t('common:navigation.performanceAdvisor'), path: 'advisors/performance', stage: 3 },
          { label: t('common:navigation.queryPerformance'), path: 'advisors/query-performance', stage: 3 },
          { label: t('common:navigation.changes'), path: 'advisors/changes', stage: 3 },
        ],
      },
    ],
  },
  observability: {
    title: t('common:navigation.observability'),
    groups: [
      {
        title: t('common:navigation.reports'),
        items: [
          { label: t('common:navigation.database'), path: 'observability', stage: 3 },
          { label: t('common:navigation.apiGateway'), path: 'observability/api', stage: 3 },
        ],
      },
    ],
  },
  logs: {
    title: t('common:navigation.logs'),
    groups: [
      {
        title: t('common:navigation.collections'),
        items: [
          { label: t('common:navigation.logsExplorer'), path: 'logs/explorer', stage: 3 },
          { label: t('common:navigation.apiGateway'), path: 'logs/edge-logs', stage: 3 },
          { label: 'Postgres', path: 'logs/postgres-logs', stage: 3 },
          { label: 'PostgREST', path: 'logs/postgrest-logs', stage: 3 },
          { label: t('common:navigation.pooler'), path: 'logs/pooler-logs', stage: 3 },
          { label: t('common:navigation.auth'), path: 'logs/auth-logs', stage: 3 },
          { label: t('common:navigation.storage'), path: 'logs/storage-logs', stage: 3 },
          { label: t('common:navigation.realtime'), path: 'logs/realtime-logs', stage: 3 },
          { label: t('common:navigation.edgeFunctions'), path: 'logs/edge-functions-logs', stage: 3 },
          { label: t('common:navigation.cron'), path: 'logs/pgcron-logs', stage: 3 },
        ],
      },
    ],
  },
  settings: {
    title: t('common:navigation.projectSettings'),
    groups: [
      {
        title: t('common:navigation.configuration'),
        items: [
          { label: t('common:navigation.general'), path: 'settings/general', stage: 1 },
          { label: t('common:navigation.infrastructure'), path: 'settings/infrastructure', stage: 4 },
          { label: t('common:navigation.apiKeys'), path: 'settings/api-keys', stage: 1 },
          { label: t('common:navigation.jwtKeys'), path: 'settings/jwt', stage: 1 },
          { label: t('common:navigation.logDrains'), path: 'settings/log-drains', stage: 4 },
        ],
      },
      {
        title: t('common:navigation.integrations'),
        items: [
          { label: t('common:navigation.dataApi'), path: 'integrations/data_api/docs', stage: 2 },
          { label: 'Vault', path: 'integrations/vault', stage: 3 },
        ],
      },
    ],
  },
}))

/** Organization settings menu (Studio's OrganizationSettingsLayout). Paths are relative to /org/$slug. */
export const orgSettingsMenu = localized((): ProductMenu => ({
  title: t('common:navigation.organizationSettings'),
  groups: [
    {
      title: t('common:navigation.configuration'),
      items: [
        { label: t('common:navigation.general'), path: 'general', stage: 1 },
        { label: t('common:navigation.security'), path: 'security', stage: 5 },
        { label: 'SSO', path: 'sso', stage: 5 },
        { label: t('common:navigation.webhooks'), path: 'webhooks', stage: 5 },
        { label: t('common:navigation.oauthApps'), path: 'apps', stage: 5, soon: true },
        { label: t('common:navigation.auditLogs'), path: 'audit', stage: 1 },
      ],
    },
  ],
}))

/** Looks up the label and stage for any project sub-path, for page titles. */
export function describeProjectPath(path: string): { label: string; stage: number } | undefined {
  for (const menu of Object.values(productMenus())) {
    for (const group of menu.groups) {
      const item = group.items.find((i) => i.path === path)
      if (item) return { label: `${menu.title}: ${item.label}`, stage: item.stage }
    }
  }
  for (const route of projectNavGroups().flat()) {
    if (route.path === path) return { label: route.label, stage: route.stage }
  }
  return undefined
}
