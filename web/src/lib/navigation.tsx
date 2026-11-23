/*
 * Navigation structure, mirroring Supabase Studio's sidebar
 * (NavigationBar.utils.tsx) and product menus (DatabaseMenu.utils.tsx,
 * AuthLayout.utils.ts, SettingsMenu.utils.tsx, …) as of 2026-11.
 *
 * `stage` marks when a page gets implemented.
 * Pages whose stage is later than the current one render a placeholder.
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

/** The implementation stage Supermixer is currently at. */
export const CURRENT_STAGE = 4

export interface NavRoute {
  key: string
  label: string
  icon: Icon
  /** Path relative to /project/$ref or /org/$slug; '' is the index page. */
  path: string
  stage: number
}

/** Project sidebar, in Studio's groups: home+tools, products, other, settings. */
export const projectNavGroups: NavRoute[][] = [
  [
    { key: 'home', label: 'Project Overview', icon: HomeIcon, path: '', stage: 1 },
    { key: 'editor', label: 'Table Editor', icon: TableEditorIcon, path: 'editor', stage: 2 },
    { key: 'sql', label: 'SQL Editor', icon: SqlEditorIcon, path: 'sql', stage: 2 },
  ],
  [
    { key: 'database', label: 'Database', icon: DatabaseIcon, path: 'database/tables', stage: 2 },
    { key: 'auth', label: 'Authentication', icon: AuthIcon, path: 'auth/users', stage: 2 },
    { key: 'storage', label: 'Storage', icon: StorageIcon, path: 'storage/buckets', stage: 2 },
    { key: 'functions', label: 'Edge Functions', icon: EdgeFunctionsIcon, path: 'functions', stage: 3 },
    { key: 'realtime', label: 'Realtime', icon: RealtimeIcon, path: 'realtime/inspector', stage: 3 },
  ],
  [
    { key: 'advisors', label: 'Advisors', icon: AdvisorsIcon, path: 'advisors/security', stage: 3 },
    { key: 'observability', label: 'Observability', icon: ObservabilityIcon, path: 'observability', stage: 3 },
    { key: 'logs', label: 'Logs', icon: LogsIcon, path: 'logs/explorer', stage: 3 },
    { key: 'integrations', label: 'Integrations', icon: IntegrationsIcon, path: 'integrations', stage: 3 },
  ],
  [{ key: 'settings', label: 'Project Settings', icon: SettingsIcon, path: 'settings/general', stage: 1 }],
]

/** Organization sidebar (Studio's OrganizationLinks, minus Billing). */
export const orgNav: NavRoute[] = [
  { key: 'projects', label: 'Projects', icon: ProjectsIcon, path: '', stage: 1 },
  { key: 'team', label: 'Team', icon: TeamIcon, path: 'team', stage: 1 },
  { key: 'integrations', label: 'Integrations', icon: IntegrationsIcon, path: 'integrations', stage: 5 },
  { key: 'usage', label: 'Usage', icon: UsageIcon, path: 'usage', stage: 3 },
  { key: 'settings', label: 'Organization Settings', icon: SettingsIcon, path: 'general', stage: 1 },
]

export interface ProductMenuItem {
  label: string
  /** Path relative to /project/$ref */
  path: string
  stage: number
  badge?: string
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
export const productMenus: Record<string, ProductMenu> = {
  database: {
    title: 'Database',
    groups: [
      {
        title: 'Database Management',
        items: [
          { label: 'Schema Visualizer', path: 'database/schemas', stage: 2 },
          { label: 'Tables', path: 'database/tables', stage: 2 },
          { label: 'Functions', path: 'database/functions', stage: 2 },
          { label: 'Triggers', path: 'database/triggers', stage: 2 },
          { label: 'Enumerated Types', path: 'database/types', stage: 2 },
          { label: 'Extensions', path: 'database/extensions', stage: 2 },
          { label: 'Indexes', path: 'database/indexes', stage: 2 },
          { label: 'Publications', path: 'database/publications', stage: 2 },
        ],
      },
      {
        title: 'Access Control',
        items: [
          { label: 'Policies', path: 'database/policies', stage: 2 },
          { label: 'Roles', path: 'database/roles', stage: 2 },
          { label: 'Column Privileges', path: 'database/column-privileges', stage: 2 },
        ],
      },
      {
        title: 'Configuration',
        items: [{ label: 'Settings', path: 'database/settings', stage: 2 }],
      },
      {
        title: 'Platform',
        items: [
          { label: 'Backups', path: 'database/backups', stage: 4 },
          { label: 'Migrations', path: 'database/migrations', stage: 2 },
        ],
      },
    ],
  },
  auth: {
    title: 'Authentication',
    groups: [
      {
        title: 'Manage',
        items: [{ label: 'Users', path: 'auth/users', stage: 2 }],
      },
      {
        title: 'Notifications',
        items: [{ label: 'Emails', path: 'auth/templates', stage: 4 }],
      },
      {
        title: 'Configuration',
        items: [
          { label: 'Policies', path: 'auth/policies', stage: 2 },
          { label: 'Sign In / Providers', path: 'auth/providers', stage: 4 },
          { label: 'Sessions', path: 'auth/sessions', stage: 4 },
          { label: 'Rate Limits', path: 'auth/rate-limits', stage: 4 },
          { label: 'Multi-Factor', path: 'auth/mfa', stage: 4 },
          { label: 'URL Configuration', path: 'auth/url-configuration', stage: 4 },
          { label: 'Attack Protection', path: 'auth/protection', stage: 4 },
          { label: 'Auth Hooks', path: 'auth/hooks', stage: 4 },
          { label: 'Audit Logs', path: 'auth/audit-logs', stage: 3 },
        ],
      },
    ],
  },
  functions: {
    title: 'Edge Functions',
    groups: [
      {
        title: 'Manage',
        items: [
          { label: 'Functions', path: 'functions', stage: 3 },
          { label: 'Secrets', path: 'functions/secrets', stage: 4 },
        ],
      },
    ],
  },
  storage: {
    title: 'Storage',
    groups: [
      {
        title: 'Manage',
        items: [
          { label: 'Buckets', path: 'storage/buckets', stage: 2 },
          { label: 'Policies', path: 'storage/policies', stage: 2 },
        ],
      },
      {
        title: 'Configuration',
        items: [
          { label: 'Settings', path: 'storage/settings', stage: 4 },
          { label: 'S3 Connection', path: 'storage/s3', stage: 4 },
        ],
      },
    ],
  },
  realtime: {
    title: 'Realtime',
    groups: [
      {
        title: 'Tools',
        items: [{ label: 'Inspector', path: 'realtime/inspector', stage: 3 }],
      },
      {
        title: 'Configuration',
        items: [{ label: 'Policies', path: 'realtime/policies', stage: 3 }],
      },
    ],
  },
  advisors: {
    title: 'Advisors',
    groups: [
      {
        title: 'Advisors',
        items: [
          { label: 'Security Advisor', path: 'advisors/security', stage: 3 },
          { label: 'Performance Advisor', path: 'advisors/performance', stage: 3 },
          { label: 'Query Performance', path: 'advisors/query-performance', stage: 3 },
        ],
      },
    ],
  },
  observability: {
    title: 'Observability',
    groups: [
      {
        title: 'Reports',
        items: [
          { label: 'Database', path: 'observability', stage: 3 },
          { label: 'API Gateway', path: 'observability/api', stage: 3 },
        ],
      },
    ],
  },
  logs: {
    title: 'Logs',
    groups: [
      {
        title: 'Collections',
        items: [
          { label: 'Logs Explorer', path: 'logs/explorer', stage: 3 },
          { label: 'API Gateway', path: 'logs/edge-logs', stage: 3 },
          { label: 'Postgres', path: 'logs/postgres-logs', stage: 3 },
          { label: 'PostgREST', path: 'logs/postgrest-logs', stage: 3 },
          { label: 'Pooler', path: 'logs/pooler-logs', stage: 3 },
          { label: 'Auth', path: 'logs/auth-logs', stage: 3 },
          { label: 'Storage', path: 'logs/storage-logs', stage: 3 },
          { label: 'Realtime', path: 'logs/realtime-logs', stage: 3 },
          { label: 'Edge Functions', path: 'logs/edge-functions-logs', stage: 3 },
          { label: 'Cron', path: 'logs/pgcron-logs', stage: 3 },
        ],
      },
    ],
  },
  settings: {
    title: 'Project Settings',
    groups: [
      {
        title: 'Configuration',
        items: [
          { label: 'General', path: 'settings/general', stage: 1 },
          { label: 'Infrastructure', path: 'settings/infrastructure', stage: 4 },
          { label: 'API Keys', path: 'settings/api-keys', stage: 1 },
          { label: 'JWT Keys', path: 'settings/jwt', stage: 1 },
          { label: 'Log Drains', path: 'settings/log-drains', stage: 4 },
        ],
      },
      {
        title: 'Integrations',
        items: [
          { label: 'Data API', path: 'integrations/data_api/docs', stage: 2 },
          { label: 'Vault', path: 'integrations/vault', stage: 3 },
        ],
      },
    ],
  },
}

/** Organization settings menu (Studio's OrganizationSettingsLayout). Paths are relative to /org/$slug. */
export const orgSettingsMenu: ProductMenu = {
  title: 'Organization Settings',
  groups: [
    {
      title: 'Configuration',
      items: [
        { label: 'General', path: 'general', stage: 1 },
        { label: 'Security', path: 'security', stage: 5 },
        { label: 'SSO', path: 'sso', stage: 5 },
        { label: 'OAuth Apps', path: 'apps', stage: 5 },
        { label: 'Audit Logs', path: 'audit', stage: 1 },
      ],
    },
  ],
}

/** Looks up the label and stage for any project sub-path, for page titles. */
export function describeProjectPath(path: string): { label: string; stage: number } | undefined {
  for (const menu of Object.values(productMenus)) {
    for (const group of menu.groups) {
      const item = group.items.find((i) => i.path === path)
      if (item) return { label: `${menu.title}: ${item.label}`, stage: item.stage }
    }
  }
  for (const route of projectNavGroups.flat()) {
    if (route.path === path) return { label: route.label, stage: route.stage }
  }
  return undefined
}
