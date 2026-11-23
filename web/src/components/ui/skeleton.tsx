import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/** Shimmering placeholder (Studio's ShimmeringLoader). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-shimmer rounded-sm bg-[length:2000px_100%]',
        'bg-[linear-gradient(to_right,var(--muted)_8%,var(--accent)_18%,var(--muted)_33%)]',
        className
      )}
      {...props}
    />
  )
}
