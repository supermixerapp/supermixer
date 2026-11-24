/*
 * Page scaffolding, following Studio's ScaffoldContainer / PageHeader
 * conventions (max-w-* px-8 containers, title + description header).
 */
import type { HTMLAttributes, ReactNode } from 'react'

import { ConstructionIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { PAGE_SIZE_CLASSES } from '@/components/ui/sizes'
import { CURRENT_STAGE } from '@/lib/navigation'
import { cn } from '@/lib/utils'

type PageSize = keyof typeof PAGE_SIZE_CLASSES

export function PageContainer({
  size = 'default',
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { size?: PageSize }) {
  return <div className={cn('mx-auto w-full', PAGE_SIZE_CLASSES[size], className)} {...props} />
}

export function PageHeader({
  title,
  description,
  actions,
  size = 'default',
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  size?: PageSize
}) {
  return (
    <div className="w-full">
      <PageContainer size={size} className="flex flex-col gap-4 pt-12 pb-6 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="heading-title">{title}</h1>
          {description && <p className="text-sm text-foreground-light">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </PageContainer>
    </div>
  )
}

/**
 * Placeholder for a page not built yet: the stage of the Supermixer plan
 * that brings it, or "Coming soon" for one not scheduled.
 */
export function ComingSoon({
  title,
  stage,
  soon,
  description,
}: {
  title: string
  stage?: number
  soon?: boolean
  description?: string
}) {
  const later = soon || stage === undefined
  return (
    <PageContainer size="small" className="flex flex-1 items-center justify-center py-16">
      <div className="flex w-full flex-col items-center gap-4 rounded-panel border border-dashed border-strong px-8 py-12 text-center">
        <ConstructionIcon size={32} className="text-foreground-lighter" />
        <div className="flex flex-col items-center gap-2">
          <h2 className="heading-section">{title}</h2>
          {later ? (
            <Badge>Coming soon</Badge>
          ) : (
            <Badge variant={stage <= CURRENT_STAGE ? 'success' : 'default'}>Stage {stage}</Badge>
          )}
        </div>
        <p className="max-w-md text-sm text-foreground-light">
          {description ??
            (later
              ? 'This page is coming soon.'
              : `This page is part of Stage ${stage} of the Supermixer plan. Supermixer is currently at Stage ${CURRENT_STAGE}.`)}
        </p>
      </div>
    </PageContainer>
  )
}
