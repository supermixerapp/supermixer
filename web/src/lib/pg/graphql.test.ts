import { describe, expect, it } from 'vitest'

import { collections, hasMutation, sampleQuery, variablesProblem, type ExplorerSchema } from './graphql'

type Ref = { name: string | null; kind: string; ofType?: Ref | null }
const nn = (t: Ref): Ref => ({ name: null, kind: 'NON_NULL', ofType: t })
const list = (t: Ref): Ref => ({ name: null, kind: 'LIST', ofType: t })
const named = (name: string, kind = 'OBJECT'): Ref => ({ name, kind })

// The shape pg_graphql reflects for a table "todos".
const schema: ExplorerSchema = {
  __schema: {
    queryType: {
      fields: [
        { name: 'todosCollection', description: 'A pagable collection of type `todos`', type: named('todosConnection') },
        { name: 'node', description: null, type: named('Node', 'INTERFACE') },
      ],
    },
    mutationType: { fields: [{ name: 'insertIntotodosCollection' }] },
    types: [
      { name: 'todosConnection', kind: 'OBJECT', fields: [{ name: 'edges', type: nn(list(nn(named('todosEdge')))) }] },
      { name: 'todosEdge', kind: 'OBJECT', fields: [{ name: 'node', type: nn(named('todos')) }] },
      {
        name: 'todos',
        kind: 'OBJECT',
        fields: [
          { name: 'nodeId', type: nn(named('ID', 'SCALAR')) },
          { name: 'id', type: nn(named('BigInt', 'SCALAR')) },
          { name: 'task', type: named('String', 'SCALAR') },
          { name: 'owner', type: named('users') },
        ],
      },
    ],
  },
}

describe('graphql explorer', () => {
  it('lists collections', () => {
    expect(collections(schema)).toEqual([{ name: 'todosCollection', description: 'A pagable collection of type `todos`' }])
  })

  it('writes a starting query with scalar columns only', () => {
    expect(sampleQuery(schema, 'todosCollection')).toBe(`query {
  todosCollection(first: 10) {
    edges {
      node {
        nodeId
        id
        task
      }
    }
  }
}`)
  })

  it('checks variables and spots mutations', () => {
    expect(variablesProblem('')).toBeNull()
    expect(variablesProblem('{"a":1}')).toBeNull()
    expect(variablesProblem('[1]')).toMatch(/object/)
    expect(variablesProblem('{')).toMatch(/valid JSON/)
    expect(hasMutation('mutation { insertIntotodosCollection(objects: []) { affectedCount } }')).toBe(true)
    expect(hasMutation('query { todosCollection(filter: {task: {eq: "mutation"}}) { totalCount } }')).toBe(false)
    expect(hasMutation('# mutation\nquery { a }')).toBe(false)
  })
})
