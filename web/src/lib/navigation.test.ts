import { describe, expect, it } from 'vitest'

import { describeProjectPath, orgNav, productMenus, projectNavGroups } from './navigation'

describe('navigation', () => {
  it('has unique product menu paths', () => {
    const paths = Object.values(productMenus).flatMap((m) => m.groups.flatMap((g) => g.items.map((i) => i.path)))
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('points every sidebar entry with a product menu at one of its pages', () => {
    for (const route of projectNavGroups.flat()) {
      const menu = productMenus[route.key]
      if (!menu) continue
      const paths = menu.groups.flatMap((g) => g.items.map((i) => i.path))
      expect(paths, route.key).toContain(route.path)
    }
  })

  it('mirrors Studio sidebar order', () => {
    expect(projectNavGroups.flat().map((r) => r.label)).toEqual([
      'Project Overview',
      'Table Editor',
      'SQL Editor',
      'Database',
      'Authentication',
      'Storage',
      'Edge Functions',
      'Realtime',
      'Advisors',
      'Observability',
      'Logs',
      'Integrations',
      'Project Settings',
    ])
    expect(orgNav.map((r) => r.label)).toEqual(['Projects', 'Team', 'Integrations', 'Usage', 'Organization Settings'])
  })

  it('describes known paths and rejects unknown ones', () => {
    expect(describeProjectPath('database/tables')).toEqual({ label: 'Database: Tables', stage: 2 })
    expect(describeProjectPath('sql')).toEqual({ label: 'SQL Editor', stage: 2 })
    expect(describeProjectPath('nope')).toBeUndefined()
  })
})
