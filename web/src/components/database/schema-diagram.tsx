/*
 * Schema Visualizer: tables as cards, foreign keys as lines between the exact
 * columns they link. Drag tables around; positions are remembered per schema
 * in this browser. Built on React Flow (@xyflow/react), as Studio is.
 */
import '@xyflow/react/dist/style.css'
import './schema-diagram.css'

import { Link } from '@tanstack/react-router'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import { useMemo, useState } from 'react'

import { KeyIcon, LinkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  layoutGraph,
  NODE_WIDTH,
  type GraphColumn,
  type GraphForeignKey,
  type GraphTable,
} from '@/lib/pg/schema-graph'
import { useTheme } from '@/lib/theme'
import { localized, t as tr } from '@/lib/i18n'

type TableNodeData = {
  projectRef: string
  /** null for a table in another schema, shown only for its referenced columns */
  tableId: number | null
  title: string
  kind: GraphTable['kind'] | 'external'
  columns: GraphColumn[]
  /** Columns that are part of a foreign key, to mark them. */
  fkColumns: string[]
}
type TableNodeT = Node<TableNodeData, 'table'>

const KIND_LABEL = localized((): Partial<Record<TableNodeData['kind'], string>> => ({ v: 'view', m: tr('database:schemaDiagram.matView'), f: 'foreign', external: tr('database:schemaDiagram.otherSchema') }))

function TableNode({ data }: NodeProps<TableNodeT>) {
  return (
    <div
      className={
        'overflow-hidden rounded-md border bg-surface-100 text-xs shadow-sm ' +
        (data.kind === 'external' ? 'border-dashed opacity-80' : 'border-strong')
      }
      style={{ width: NODE_WIDTH }}
    >
      <div className="flex h-10 items-center gap-2 border-b bg-surface-200 px-3">
        {data.tableId !== null && (data.kind === 'r' || data.kind === 'p') ? (
          <Link
            to="/project/$ref/editor/$id"
            params={{ ref: data.projectRef, id: String(data.tableId) }}
            className="nodrag truncate text-sm text-foreground hover:underline"
            title={tr('database:schemaDiagram.openInTheTableEditor')}
          >
            {data.title}
          </Link>
        ) : (
          <span className="truncate text-sm text-foreground">{data.title}</span>
        )}
        {KIND_LABEL()[data.kind] && <span className="ml-auto shrink-0 text-[10px] text-foreground-muted uppercase">{KIND_LABEL()[data.kind]}</span>}
      </div>
      <ul className="py-1">
        {data.columns.length === 0 && <li className="px-3 py-1 text-foreground-lighter">{tr('database:schemaDiagram.noColumns')}</li>}
        {data.columns.map((c) => (
          <li key={c.name} className="relative flex h-[26px] items-center gap-1.5 px-3">
            <Handle type="target" position={Position.Left} id={`l-${c.name}`} isConnectable={false} />
            <span className="flex w-3.5 shrink-0 justify-center text-foreground-lighter">
              {c.pk ? <KeyIcon size={12} className="text-warning" /> : data.fkColumns.includes(c.name) ? <LinkIcon size={12} /> : null}
            </span>
            <span className={'truncate ' + (c.pk ? 'text-foreground' : 'text-foreground-light')}>{c.name}</span>
            {/* Only the names of another schema's columns are known. */}
            {data.kind !== 'external' && (
              <span className="ml-auto truncate pl-2 font-mono text-[11px] text-foreground-lighter">
                {c.type}
                {c.nullable ? '' : ' !'}
              </span>
            )}
            <Handle type="source" position={Position.Right} id={`r-${c.name}`} isConnectable={false} />
          </li>
        ))}
      </ul>
    </div>
  )
}

const nodeTypes = { table: TableNode }

/** Nodes and edges for one schema, positioned from `saved` where known. */
function buildGraph(projectRef: string, schema: string, tables: GraphTable[], fks: GraphForeignKey[], saved: Record<string, unknown>) {
  const ids = new Set(tables.map((t) => String(t.id)))
  const nodes: TableNodeT[] = tables.map((t) => ({
    id: String(t.id),
    type: 'table',
    position: { x: 0, y: 0 },
    data: {
      projectRef,
      tableId: t.id,
      title: t.name,
      kind: t.kind,
      columns: t.columns,
      fkColumns: fks.filter((f) => f.source === t.id).flatMap((f) => f.source_columns),
    },
  }))
  // Tables in other schemas (e.g. auth.users) appear with just the referenced columns.
  for (const f of fks) {
    const id = String(f.target)
    if (ids.has(id)) continue
    const existing = nodes.find((n) => n.id === id)
    const cols = f.target_columns.map((name) => ({ name, type: '', nullable: false, pk: false, unique: false, identity: false }))
    if (existing) {
      for (const c of cols) if (!existing.data.columns.some((x) => x.name === c.name)) existing.data.columns.push(c)
    } else {
      nodes.push({
        id,
        type: 'table',
        position: { x: 0, y: 0 },
        data: { projectRef, tableId: null, title: f.target_schema === schema ? f.target_table : `${f.target_schema}.${f.target_table}`, kind: 'external', columns: cols, fkColumns: [] },
      })
    }
  }
  const edges: Edge[] = fks.flatMap((f) =>
    f.source_columns.map((col, i) => ({
      // Constraint names are only unique per table.
      id: `${f.source}:${f.name}:${i}`,
      source: String(f.target),
      sourceHandle: `r-${f.target_columns[i]}`,
      target: String(f.source),
      targetHandle: `l-${col}`,
      type: 'smoothstep',
      ariaLabel: `${f.name}: ${col} references ${f.target_table}.${f.target_columns[i]}`,
    }))
  )
  const auto = layoutGraph(
    nodes.map((n) => ({ id: n.id, columns: n.data.columns.length })),
    fks.map((f) => ({ from: String(f.source), to: String(f.target) }))
  )
  for (const n of nodes) n.position = savedPosition(saved, n.data.title) ?? auto[n.id] ?? { x: 0, y: 0 }
  return { nodes, edges, auto }
}

/** A saved position, ignoring anything inherited (a table called "constructor") or malformed. */
function savedPosition(saved: Record<string, unknown>, name: string): { x: number; y: number } | undefined {
  if (!Object.hasOwn(saved, name)) return undefined
  const p = saved[name] as { x?: unknown; y?: unknown } | null
  return p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : undefined
}

const storageKey = (ref: string, schema: string) => `supermixer:schema-layout:${ref}:${schema}`

function readSaved(ref: string, schema: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(storageKey(ref, schema))
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeSaved(ref: string, schema: string, nodes: TableNodeT[] | null) {
  try {
    if (!nodes) localStorage.removeItem(storageKey(ref, schema))
    // Keyed by table name, so positions survive a table being recreated.
    else localStorage.setItem(storageKey(ref, schema), JSON.stringify(Object.fromEntries(nodes.map((n) => [n.data.title, n.position]))))
  } catch {
    // Storage unavailable: positions just aren't remembered.
  }
}

/** Mount with a key that changes when the data does, so it starts from fresh nodes. */
export function SchemaDiagram({ projectRef, schema, tables, fks }: { projectRef: string; schema: string; tables: GraphTable[]; fks: GraphForeignKey[] }) {
  const { resolved } = useTheme()
  const graph = useMemo(() => buildGraph(projectRef, schema, tables, fks, readSaved(projectRef, schema)), [projectRef, schema, tables, fks])
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeT>(graph.nodes)
  const [flow, setFlow] = useState<ReactFlowInstance<TableNodeT> | null>(null)

  return (
    <div className="schema-diagram relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onInit={setFlow}
        onNodeDragStop={(_, __, dragged) => {
          // `dragged` has the final positions; the rest are as last rendered.
          const moved = new Map(dragged.map((n) => [n.id, n.position]))
          writeSaved(projectRef, schema, nodes.map((n) => ({ ...n, position: moved.get(n.id) ?? n.position })))
        }}
        colorMode={resolved}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.1}
        nodesConnectable={false}
        edgesFocusable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={0} />
      </ReactFlow>
      <div className="absolute top-3 right-3 flex gap-2">
        <Button
          variant="default"
          size="tiny"
          onClick={() => {
            writeSaved(projectRef, schema, null)
            setNodes((ns) => ns.map((n) => ({ ...n, position: graph.auto[n.id] ?? n.position })))
            // Bring the re-laid-out tables into view once they've moved.
            requestAnimationFrame(() => void flow?.fitView({ padding: 0.15, maxZoom: 1, duration: 300 }))
          }}
        >
          {tr('database:schemaDiagram.autoLayout')}
        </Button>
      </div>
    </div>
  )
}
