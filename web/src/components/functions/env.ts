/**
 * Reads KEY=value lines as pasted from a .env file. Comments and blank lines
 * are skipped; values may be quoted. Returns nothing unless the text holds at
 * least one KEY=value line, so pasting a plain name isn't intercepted.
 */
export function parseEnv(text: string): { name: string; value: string }[] {
  if (!text.includes('=')) return []
  const out: { name: string; value: string }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!
    const q = value[0]
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1)
      // One pass, so an escaped backslash before n stays a backslash and an n.
      if (q === '"') value = value.replace(/\\(.)/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    out.push({ name: m[1]!, value })
  }
  return out
}
