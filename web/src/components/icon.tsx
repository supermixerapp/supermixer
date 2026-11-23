import type { ComponentType, SVGProps } from 'react'

import { cn } from '@/lib/utils'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  /** Pixel size; defaults to 20 (Studio's sidebar and menu icon size). */
  size?: number
  /** Accessible name. Omit for decorative icons, which are hidden from assistive tech. */
  label?: string
}

export type Icon = ComponentType<IconProps> & { materialName: string }

/**
 * Wraps a Material two-tone SVG so both tones follow `currentColor`. The
 * secondary tone keeps the icon set's built-in opacity of 0.3.
 */
export function createIcon(Svg: ComponentType<SVGProps<SVGSVGElement>>, materialName: string): Icon {
  const Component = ({ size = 20, label, className, ...props }: IconProps) => (
    <Svg
      width={size}
      height={size}
      fill="currentColor"
      focusable={false}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      data-icon={materialName}
      className={cn('shrink-0', className)}
      {...props}
    />
  )
  Component.displayName = `Icon(${materialName})`
  return Object.assign(Component, { materialName })
}
