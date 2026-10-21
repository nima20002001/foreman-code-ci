import { create } from 'zustand'
import type { MemoryChange } from '../../memory-boards'

/** One card an Agent just changed. The card shows who changed it for SHOW_MS; a light travels from the
 * Agent's node to the Kanban while pulsing. Local interaction state, never shared or saved. */
export type KanbanCardActivity = { key: string; cardId: string; agent: string; nodeId?: string; startsAt: number; pulsing: boolean }
const SHOW_MS = 8000, PULSE_MS = 3600

export const useKanbanActivity = create<{ items: Record<string, readonly KanbanCardActivity[]> }>(() => ({ items: {} }))
export const kanbanScope = (workspaceId: string, workflowId: string) => `${workspaceId}/${workflowId}`

function update(scope: string, change: (items: readonly KanbanCardActivity[]) => readonly KanbanCardActivity[]) {
  useKanbanActivity.setState((state) => ({ items: { ...state.items, [scope]: change(state.items[scope] ?? []) } }))
}

/** Only Agent work counts: an Agent's board result or memory tool, or its work moving the card. A person's
 * own edit is not announced. The node is the exact acting node, else the only node running that Agent. */
export function reportKanbanActivity(scope: string, change: MemoryChange, nodes: readonly { id: string; agentId: string }[]) {
  if (change.entity !== 'card' || change.actor.kind === 'operator') return
  const running = nodes.filter((node) => node.agentId === change.actor.id)
  const nodeId = change.provenance?.subject?.agent.workflowNodeId ?? (running.length === 1 ? running[0]!.id : undefined)
  const item: KanbanCardActivity = { key: change.id, cardId: change.entityId, agent: change.actor.displayName,
    ...(nodeId ? { nodeId } : {}), startsAt: performance.now(), pulsing: true }
  update(scope, (items) => [...items.filter((old) => old.cardId !== item.cardId), item])
  setTimeout(() => update(scope, (items) => items.map((old) => old.key === item.key ? { ...old, pulsing: false } : old)), PULSE_MS)
  setTimeout(() => update(scope, (items) => items.filter((old) => old.key !== item.key)), SHOW_MS)
}
