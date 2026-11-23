/*
 * GraphiQL: GraphQL over pg_graphql, run through SQL with graphql.resolve so
 * it follows the same read-only rules as every other query. It runs as the
 * database user Supermixer connects with, not as anon or authenticated.
 */

/** $1 query, $2 variables (JSON text or ''), $3 operation name (or ''). */
export const GRAPHQL_SQL = `
select graphql.resolve(query := $1, variables := coalesce(nullif($2, '')::jsonb, '{}'), "operationName" := nullif($3, '')) as result`

/** Enough of the schema to list collections and write a starting query for each. */
export const EXPLORER_QUERY = `{
  __schema {
    queryType { fields { name description type { name kind ofType { name kind } } } }
    mutationType { fields { name } }
    types { name kind fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } }
  }
}`

interface TypeRef {
  name: string | null
  kind: string
  ofType?: TypeRef | null
}

export interface ExplorerSchema {
  __schema: {
    queryType: { fields: { name: string; description: string | null; type: TypeRef }[] }
    mutationType: { fields: { name: string }[] } | null
    types: { name: string; kind: string; fields: { name: string; type: TypeRef }[] | null }[]
  }
}

/** The named type under NON_NULL and LIST wrappers. */
function base(t: TypeRef | null | undefined): TypeRef | null {
  let cur = t ?? null
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) cur = cur.ofType ?? null
  return cur
}

/** Query fields that page through rows (pg_graphql's xyzCollection). */
export function collections(schema: ExplorerSchema): { name: string; description: string | null }[] {
  return schema.__schema.queryType.fields
    .filter((f) => f.name.endsWith('Collection'))
    .map((f) => ({ name: f.name, description: f.description }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** A first query for a collection: its scalar columns, ten rows. */
export function sampleQuery(schema: ExplorerSchema, field: string): string {
  const types = new Map(schema.__schema.types.map((t) => [t.name, t]))
  const f = schema.__schema.queryType.fields.find((x) => x.name === field)
  const connection = types.get(base(f?.type)?.name ?? '')
  const edge = types.get(base(connection?.fields?.find((x) => x.name === 'edges')?.type)?.name ?? '')
  const node = types.get(base(edge?.fields?.find((x) => x.name === 'node')?.type)?.name ?? '')
  const columns = (node?.fields ?? []).filter((x) => {
    const k = base(x.type)?.kind
    return k === 'SCALAR' || k === 'ENUM'
  })
  const names = columns.length ? columns.map((c) => c.name) : ['nodeId']
  return `query {
  ${field}(first: 10) {
    edges {
      node {
${names.map((n) => `        ${n}`).join('\n')}
      }
    }
  }
}`
}

/** Valid JSON object text, or empty. */
export function variablesProblem(s: string): string | null {
  if (!s.trim()) return null
  try {
    const v: unknown = JSON.parse(s)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? null : 'Variables must be a JSON object'
  } catch {
    return 'Variables must be valid JSON'
  }
}

/** Whether a document contains a mutation, which only members who can change data may run. */
export function hasMutation(query: string): boolean {
  const withoutStrings = query.replace(/"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"/g, '""').replace(/#[^\n]*/g, '')
  return /\bmutation\b/.test(withoutStrings)
}
