import { forwardRef, type HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/** Studio's panel: bg-surface-100, 1px border, 6px radius. */
export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('overflow-hidden rounded-panel border bg-surface-100', className)} {...props} />
))
Card.displayName = 'Card'

export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center justify-between border-b px-card py-4', className)} {...props} />
)
export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('font-sans text-sm font-normal text-foreground', className)} {...props} />
)
export const CardDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-sm text-foreground-lighter', className)} {...props} />
)
export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-card py-4', className)} {...props} />
)
export const CardFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center justify-end gap-2 border-t px-card py-3', className)} {...props} />
)
