/*
 * Edge Functions of stacks Supermixer created: queries and limits shared by
 * the list, function and secrets pages.
 */
import { api, unwrap, type Schemas } from '@/lib/api/client'

export type EdgeFunction = Schemas['EdgeFunction']
export type FunctionFile = Schemas['EdgeFunctionFile']

export const functionsQuery = (ref: string) => ({
  queryKey: ['projects', ref, 'functions'],
  queryFn: () => unwrap(api.GET('/projects/{ref}/functions', { params: { path: { ref } } })),
})

export const functionQuery = (ref: string, name: string) => ({
  queryKey: ['projects', ref, 'functions', name],
  queryFn: () => unwrap(api.GET('/projects/{ref}/functions/{name}', { params: { path: { ref, name } } })),
  retry: false,
  // The page edits a copy; refetching in the background would replace the edits.
  staleTime: Infinity,
  refetchOnWindowFocus: false,
})

export const functionSecretsQuery = (ref: string) => ({
  queryKey: ['projects', ref, 'function-secrets'],
  queryFn: () => unwrap(api.GET('/projects/{ref}/function-secrets', { params: { path: { ref } } })),
})

/** Why name can't be a new function's name, or null (as the server checks, plus
 * names Supermixer's own pages use). */
export function functionNameProblem(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) return 'Start with a letter; up to 64 letters, digits, - and _'
  if (name === 'main') return 'main is the edge runtime’s router'
  if (name === 'secrets') return 'secrets is the name of the Secrets page'
  return null
}

const SEGMENT = /^[A-Za-z0-9_@+=,-][A-Za-z0-9_.@+=, -]*$/

/** Why p can't be a file's path in a function, or null. */
export function filePathProblem(p: string): string | null {
  if (!p || p.length > 255) return 'Use 1 to 255 characters'
  const parts = p.split('/')
  if (parts.length > 10) return 'Folders nest at most 10 deep'
  if (parts.some((s) => !SEGMENT.test(s) || s.endsWith(' ')))
    return 'A relative path of letters, digits, spaces and . _ - @ + = , with no leading dots'
  return null
}

export const ENTRYPOINTS = ['index.ts', 'index.js', 'index.tsx', 'index.jsx', 'index.mts', 'index.mjs']

export const NEW_FUNCTION_FILES: FunctionFile[] = [
  {
    path: 'index.ts',
    content: `// Answers requests to /functions/v1/<this function's name>.
// The stack's URL and keys are in Deno.env: SUPABASE_URL, SUPABASE_ANON_KEY, …

Deno.serve(async (req) => {
  const { name } = await req.json().catch(() => ({ name: 'world' }))
  return Response.json({ message: \`Hello \${name}!\` })
})
`,
  },
]

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
