/** Quote an identifier: my table → "my table", a"b → "a""b". */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** schema.table, both quoted. */
export function qualified(schema: string, name: string): string {
  return `${ident(schema)}.${ident(name)}`
}

/** Quote a text literal. Uses E'' only when needed for backslashes. */
export function literal(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'null'
  const escaped = value.replace(/'/g, "''")
  return value.includes('\\') ? `E'${escaped.replace(/\\/g, '\\\\')}'` : `'${escaped}'`
}

/**
 * Split a script into statements for "run selected statement" style
 * features. Understands quotes, dollar quotes and comments; not a parser.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end + 1
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
    } else if (c === "'" || c === '"') {
      i++
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) i += 2
        else if (sql[i] === c) break
        else i++
      }
      i++
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length)
        i = end === -1 ? sql.length : end + m[0].length
      } else i++
    } else if (c === ';') {
      out.push(sql.slice(start, i + 1))
      start = i + 1
      i++
    } else i++
  }
  out.push(sql.slice(start))
  return out.map((s) => s.trim()).filter((s) => s && s !== ';')
}

/** A value from a query result as the text Postgres would accept back. */
export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
