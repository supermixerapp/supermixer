// Control sizes from Supabase packages/ui/src/lib/constants.ts (Apache-2.0; see NOTICE).
export const SIZE_VARIANTS = {
  tiny: 'text-xs px-2.5 py-1 h-[26px]',
  small: 'text-sm leading-4 px-3 py-2 h-[34px]',
  medium: 'text-sm px-4 py-2 h-[38px]',
  large: 'text-base px-4 py-2 h-[42px]',
  xlarge: 'text-base px-6 py-3 h-[50px]',
} as const

// Larger controls get proportionally rounder corners (raised-control-surface.ts).
export const CONTROL_RADIUS = {
  tiny: 'rounded-md',
  small: 'rounded-[calc(var(--radius-md)*(1+(34/26-1)*0.35))]',
  medium: 'rounded-[calc(var(--radius-md)*(1+(38/26-1)*0.35))]',
  large: 'rounded-[calc(var(--radius-md)*(1+(42/26-1)*0.35))]',
  xlarge: 'rounded-[calc(var(--radius-md)*(1+(50/26-1)*0.35))]',
} as const

export type ControlSize = keyof typeof SIZE_VARIANTS

export const PAGE_SIZE_CLASSES = {
  small: 'max-w-3xl px-8',
  medium: 'max-w-5xl px-8',
  large: 'max-w-7xl px-8',
  default: 'max-w-5xl px-8',
  full: 'w-full',
} as const
