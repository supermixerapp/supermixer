import { forwardRef } from 'react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * A disabled button that says why in a tooltip, for something not allowed
 * right now (a resource limit reached); see PermissionButton for permissions.
 */
export const BlockedButton = forwardRef<HTMLButtonElement, ButtonProps & { reason: string }>(
  ({ reason, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0} aria-label={reason}>
          <Button ref={ref} {...props} disabled />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  )
)
BlockedButton.displayName = 'BlockedButton'
