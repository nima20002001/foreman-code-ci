import { memo, useCallback, useMemo, useRef } from 'react'
import { Handle, NodeResizer, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { MemoryBoardWireSchemas, type MemoryBoardScope, type MemoryCard as Card, type WorkflowKanbanFrame } from '@foreman-code/contracts'
import { Button, Icon, IconButton } from '../../../shared/ui/nocturne'
import { useManagedWorkflowQuery } from '../../../shared/api/query'
import { MemoryCard } from '../../memory-boards/MemoryCard'
import { createMemoryBoardClient } from '../../memory-boards/client'
import { mergedMemoryItems, useMemoryBoard, useMemoryCards } from '../../memory-boards/queries'
import { errorMessage, statusLabels } from '../../memory-boards/presentation'
import type { MemoryBoardView, MemoryChange, MemoryNodeOption } from '../../memory-boards/ports'
import { PulseFlight, type EdgePulse } from '../../graph/SignalEdgeShape'
import { useFloatingCurve } from '../../graph/signalEdge'
import { useWorkflowBoard } from '../context'
import { kanbanScope, reportKanbanActivity, useKanbanActivity, type KanbanCardActivity } from './kanbanActivity'
import './boardKanban.css'

const client = createMemoryBoardClient(MemoryBoardWireSchemas)
export const KANBAN_NODE_ID = 'board-kanban'
const KANBAN_MIN = { width: 240, height: 160 }

export type KanbanFlowNode = Node<{ workspaceId: string; workflowId: string; saveError?: string
  remove(): void; resized(frame: WorkflowKanbanFrame): void }, 'boardKanban'>

/** The workflow's memory board as one Board object: drag it by its bar, resize it from its edges, remove it
 * with its X (that only hides it). Each card inside is its own element and shows an Agent's change live. */
export const BoardKanbanNode = memo(function BoardKanbanNode({ data }: NodeProps<KanbanFlowNode>) {
  return <section className="board-kanban" aria-label="Kanban">
    <NodeResizer minWidth={KANBAN_MIN.width} minHeight={KANBAN_MIN.height} handleClassName="board-kanban-resize"
      onResizeEnd={(_event, frame) => data.resized(frame)} />
    <header className="board-kanban-bar" title="Drag to move the Kanban">
      <h2><Icon name="grid" size={14} />Kanban</h2>
      {data.saveError ? <span className="board-kanban-error" role="alert">Layout not saved: {data.saveError}</span> : null}
      <IconButton size="sm" variant="ghost" className="nodrag" label="Remove Kanban from Board" onClick={data.remove}>
        <Icon name="close" size={14} /></IconButton>
    </header>
    <div className="board-kanban-body nodrag nopan nowheel">
      <KanbanColumns workspaceId={data.workspaceId} workflowId={data.workflowId} />
    </div>
    {/* Only for the passing lights from Agents; nothing connects to the Kanban. */}
    <Handle id="left" type="target" position={Position.Left} isConnectable={false} className="board-kanban-target" />
  </section>
})

function KanbanColumns({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const board = useWorkflowBoard()
  const scope = useMemo<MemoryBoardScope>(() => ({ kind: 'workflow', workspaceId, workflowId }), [workspaceId, workflowId])
  const workflow = useManagedWorkflowQuery(workspaceId, workflowId)
  const graphNodes = useMemo(() => (workflow.data?.workflow.nodes ?? []).flatMap(node => node.kind === 'job' ? []
    : [{ id: node.id, agentId: node.agentId, label: node.name ?? node.label ?? node.id }]), [workflow.data])
  const nodes = useMemo<MemoryNodeOption[]>(() => graphNodes.map(node => ({ label: node.label, available: true, currentWork: [],
    node: { workspaceId, workflowId, workflowNodeId: node.id, agentId: node.agentId } })), [graphNodes, workspaceId, workflowId])
  const known = useRef(graphNodes)
  known.current = graphNodes
  const activityScope = kanbanScope(workspaceId, workflowId)
  const changed = useCallback((change: MemoryChange) => reportKanbanActivity(activityScope, change, known.current), [activityScope])
  const live = useMemoryBoard(client, scope, changed)
  const view = live.snapshot.data, error = live.identity.error ?? live.snapshot.error
  const activity = useKanbanActivity((state) => state.items[activityScope])
  const byCard = useMemo(() => new Map((activity ?? []).map((item) => [item.cardId, item])), [activity])
  if (!view) return error ? <p role="alert">Couldn’t load the Kanban. {errorMessage(error)}
    <Button size="sm" onClick={() => void live.retry()}>Retry</Button></p> : <p role="status">Loading Kanban…</p>
  return <div className="board-kanban-columns" role="region" aria-label="Kanban columns">
    {(Object.keys(statusLabels) as Card['status'][]).map((status) => <KanbanColumn key={status} view={view}
      status={status} nodes={nodes} activity={byCard} onOpen={(cardId) => board?.openMemoryCard?.(cardId)} />)}
  </div>
}

function KanbanColumn({ view, status, nodes, activity, onOpen }: {
  view: MemoryBoardView; status: Card['status']; nodes: readonly MemoryNodeOption[]
  activity: ReadonlyMap<string, KanbanCardActivity>; onOpen(cardId: string): void
}) {
  const query = useMemoryCards(client, view, { status }, true)
  const cards = mergedMemoryItems(query.data?.pages)
  return <section className="board-kanban-column" aria-label={statusLabels[status]}>
    <h3>{statusLabels[status]} <small>{view.counts[status]}</small></h3>
    {query.isError ? <p role="alert">Couldn’t load cards. <Button size="sm" onClick={() => void query.restart()}>Retry</Button></p> : null}
    {cards.map((card) => {
      const changed = activity.get(card.id)
      return <div key={card.id} className="board-kanban-card" data-card-id={card.id} data-updated={changed ? '' : undefined}>
        <MemoryCard card={card} nodes={nodes} onOpen={() => onOpen(card.id)} />
        {changed ? <p className="board-kanban-updated" role="status">Updated by {changed.agent}</p> : null}
      </div>
    })}
    {query.hasNextPage ? <Button size="sm" variant="ghost" loading={query.isFetchingNextPage} loadingLabel="Loading cards…"
      onClick={() => void query.fetchNextPage()}>Load more {statusLabels[status]}</Button> : null}
  </section>
}

export type KanbanActivityFlowEdge = Edge<{ pulse: EdgePulse }, 'kanbanActivity'>
/** The light from the Agent that changed a card to the Kanban; it exists only while it travels. */
export const KanbanActivityEdge = memo(function KanbanActivityEdge({ source, target, data }: EdgeProps<KanbanActivityFlowEdge>) {
  const curve = useFloatingCurve(source, target, 0)
  if (!curve || !data) return null
  return <g className="board-kanban-flight" aria-hidden="true"><PulseFlight path={curve.path} pulse={data.pulse} /></g>
})
