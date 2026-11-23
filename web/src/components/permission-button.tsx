import { forwardRef } from 'react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * A button that is disabled, with Studio's "You need additional permissions"
 * tooltip, when the user lacks a permission.
 */
export const PermissionButton = forwardRef<
  HTMLButtonElement,
  ButtonProps & { allowed: boolean; action: string }
>(({ allowed, action, disabled, ...props }, ref) => {
  if (allowed) return <Button ref={ref} disabled={disabled} {...props} />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button ref={ref} disabled {...props} />
        </span>
      </TooltipTrigger>
      <TooltipContent>You need additional permissions to {action}</TooltipContent>
    </Tooltip>
  )
})
PermissionButton.displayName = 'PermissionButton'
