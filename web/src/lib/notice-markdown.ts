/*
 * The little Markdown a global notice may use: **bold** and [links](url).
 * Anything else stays as typed. Parsed to a tree (rendered as React
 * elements, never as HTML); links only to http(s), mailto: or a path in
 * Supermixer (the server refuses others too).
 */

export type NoticeNode =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: NoticeNode[] }
  | { kind: 'link'; href: string; external: boolean; children: NoticeNode[] }

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*/

/** Whether a link may be followed: http(s) and mailto: URLs, or a path here. */
export function safeNoticeHref(href: string): { ok: boolean; external: boolean } {
  if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\'))
    return { ok: true, external: false }
  try {
    const u = new URL(href)
    if (u.protocol === 'mailto:') return { ok: true, external: true }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host)
      return { ok: true, external: true }
  } catch {
    // not a URL
  }
  return { ok: false, external: true }
}

/**
 * Parses a message. Bold may hold links and link text may be bold, but
 * neither nests in itself.
 */
export function parseNotice(message: string, inside: 'bold' | 'link' | null = null): NoticeNode[] {
  const nodes: NoticeNode[] = []
  let rest = message
  while (rest) {
    const link = inside === 'link' ? null : LINK.exec(rest)
    const bold = inside === 'bold' ? null : BOLD.exec(rest)
    const m = link && (!bold || link.index <= bold.index) ? link : bold
    if (!m) break
    if (m.index > 0) nodes.push({ kind: 'text', text: rest.slice(0, m.index) })
    if (m === link) {
      const [whole, label, href] = m as unknown as [string, string, string]
      const safe = safeNoticeHref(href)
      nodes.push(
        safe.ok
          ? { kind: 'link', href, external: safe.external, children: parseNotice(label, 'link') }
          : { kind: 'text', text: whole }
      )
    } else {
      nodes.push({ kind: 'bold', children: parseNotice(m[1]!, 'bold') })
    }
    rest = rest.slice(m.index + m[0].length)
  }
  if (rest) nodes.push({ kind: 'text', text: rest })
  return nodes
}

/** The message's words without the Markdown (for tooltips and labels). */
export function noticePlainText(nodes: NoticeNode[]): string {
  return nodes.map((n) => (n.kind === 'text' ? n.text : noticePlainText(n.children))).join('')
}
