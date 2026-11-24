/**
 * Only same-origin paths are accepted as a post-sign-in destination. Without
 * one it's the dashboard (/dashboard), which opens the organization's
 * projects for someone in just one.
 */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) {
    return '/dashboard'
  }
  return target
}
