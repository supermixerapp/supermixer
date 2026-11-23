/** Only same-origin paths are accepted as a post-sign-in destination. */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) {
    return '/organizations'
  }
  return target
}
