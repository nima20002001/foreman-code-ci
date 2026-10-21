import { create } from 'zustand'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'

/**
 * Board settings that save straight to the server (for example the schedule) join the draft's
 * undo history here. An action remembers the draft position including evicted steps, so
 * Ctrl+Z steps back through draft edits and settings changes in the order they were made.
 */
export type BoardAction = { id: string; label: string; depth: number; undo(): Promise<void>; redo(): Promise<void> }
type Redo = { kind: 'draft' } | { kind: 'action'; action: BoardAction }
export type BoardChange = { id: string; at: string; text: string }

interface BoardUndoState {
  actions: Record<string, BoardAction[]>
  redo: Record<string, Redo[]>
  changes: Record<string, BoardChange[]>
  notice?: { scope: string; id: string; text: string }
  /** Current draft history position per scope, including evicted steps. */
  depth: Record<string, number>
  /** Serializes a history step through its stack move; TanStack owns its server command. */
  pending: Record<string, boolean>
  /** Acknowledged history revisions detect intervening edits; they do not mirror polling results. */
  scheduleRevisions: Record<string, number>
}

export const boardScope = (workspaceId: string, workflowId: string) => JSON.stringify([workspaceId, workflowId])

export const useBoardUndo = create<BoardUndoState>(() => ({
  actions: {}, redo: {}, changes: {}, depth: {}, pending: {}, scheduleRevisions: {},
}))

export function recordBoardAction(scope: string, action: Omit<BoardAction, 'id' | 'depth'>) {
  useBoardUndo.setState((state) => ({
    actions: { ...state.actions, [scope]: [...(state.actions[scope] ?? []).slice(-49),
      { ...action, id: crypto.randomUUID(), depth: state.depth[scope] ?? 0 }] },
    redo: { ...state.redo, [scope]: [] },
  }))
}

export function publishDraftDepth(scope: string, depth: number) {
  if (useBoardUndo.getState().depth[scope] !== depth) useBoardUndo.setState((state) => ({ depth: { ...state.depth, [scope]: depth } }))
}

/** A new edit makes earlier undone steps unreachable, exactly like the draft's own redo. */
export function clearBoardRedo(scope: string) {
  if (useBoardUndo.getState().redo[scope]?.length) useBoardUndo.setState((state) => ({ redo: { ...state.redo, [scope]: [] } }))
}

/** The settings action to undo before the next draft step, if one is newer than it. */
export function pendingBoardAction(scope: string, draftDepth: number) {
  const action = useBoardUndo.getState().actions[scope]?.at(-1)
  return action && action.depth >= draftDepth ? action : undefined
}

export function popBoardAction(scope: string, action: BoardAction) {
  useBoardUndo.setState((state) => ({
    actions: { ...state.actions, [scope]: (state.actions[scope] ?? []).filter((item) => item.id !== action.id) },
    redo: { ...state.redo, [scope]: [...(state.redo[scope] ?? []), { kind: 'action', action }] },
  }))
}

export function pushDraftRedo(scope: string) {
  useBoardUndo.setState((state) => ({ redo: { ...state.redo, [scope]: [...(state.redo[scope] ?? []), { kind: 'draft' }] } }))
}

export function popBoardRedo(scope: string): Redo | undefined {
  const next = useBoardUndo.getState().redo[scope]?.at(-1)
  if (!next) return undefined
  useBoardUndo.setState((state) => ({ redo: { ...state.redo, [scope]: (state.redo[scope] ?? []).slice(0, -1) } }))
  if (next.kind === 'action') {
    useBoardUndo.setState((state) => ({ actions: { ...state.actions, [scope]: [...(state.actions[scope] ?? []),
      { ...next.action, depth: state.depth[scope] ?? 0 }] } }))
  }
  return next
}

export function peekBoardRedo(scope: string): Redo | undefined {
  return useBoardUndo.getState().redo[scope]?.at(-1)
}

/** Move a server-backed step only after its command is acknowledged. */
export async function executeBoardAction(scope: string, direction: 'undo' | 'redo', draftDepth: number): Promise<boolean> {
  if (useBoardUndo.getState().pending[scope]) return false
  const redo = direction === 'redo' ? peekBoardRedo(scope) : undefined
  let action = pendingBoardAction(scope, draftDepth)
  if (direction === 'redo') action = redo?.kind === 'action' ? redo.action : undefined
  if (!action) return false
  useBoardUndo.setState(state => ({ pending: { ...state.pending, [scope]: true } }))
  try {
    await action[direction]()
    if (direction === 'undo') popBoardAction(scope, action)
    else if (peekBoardRedo(scope) === redo) popBoardRedo(scope)
    announceBoardChange(scope, `${direction === 'undo' ? 'Undid' : 'Redid'} ${action.label}`)
    return true
  } finally {
    useBoardUndo.setState(state => ({ pending: { ...state.pending, [scope]: false } }))
  }
}

/** Shows the bottom-right notice and keeps the change in this Board's change list. */
export function announceBoardChange(scope: string, text: string) {
  const id = crypto.randomUUID()
  useBoardUndo.setState((state) => ({ notice: { scope, id, text },
    changes: { ...state.changes, [scope]: [{ id, at: new Date().toISOString(), text }, ...(state.changes[scope] ?? [])].slice(0, 100) } }))
}

export function dismissBoardNotice(id: string) {
  if (useBoardUndo.getState().notice?.id === id) useBoardUndo.setState({ notice: undefined })
}

const quoted = (value: string) => `“${value}”`
const nodeName = (node: WorkflowDefinitionV3['nodes'][number]) => node.name ?? node.label ?? 'node'

/** Plain words for what one draft step changed, from `before` to `after`. */
export function describeDraftChange(before: WorkflowDefinitionV3, after: WorkflowDefinitionV3): string {
  const parts: string[] = []
  if (before.name !== after.name) parts.push(`workflow name ${quoted(before.name)} → ${quoted(after.name)}`)
  if (JSON.stringify(before.defaultWorktree ?? null) !== JSON.stringify(after.defaultWorktree ?? null)) parts.push('worktree')
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]))
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]))
  for (const node of after.nodes) if (!beforeNodes.has(node.id)) parts.push(`added ${quoted(nodeName(node))}`)
  for (const node of before.nodes) if (!afterNodes.has(node.id)) parts.push(`removed ${quoted(nodeName(node))}`)
  let moved = 0
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id)
    if (!previous) continue
    if (nodeName(previous) !== nodeName(node)) parts.push(`renamed ${quoted(nodeName(previous))} → ${quoted(nodeName(node))}`)
    const { position: a, width: aw, height: ah, ...restBefore } = previous
    const { position: b, width: bw, height: bh, ...restAfter } = node
    if (JSON.stringify(a) !== JSON.stringify(b) || aw !== bw || ah !== bh) moved++
    if (nodeName(previous) === nodeName(node) && JSON.stringify(restBefore) !== JSON.stringify(restAfter)) parts.push(`${quoted(nodeName(node))} settings`)
  }
  if (moved) parts.push(moved === 1 ? 'moved a node' : `moved ${moved} nodes`)
  const edges = after.edges.length - before.edges.length
  if (edges > 0) parts.push(edges === 1 ? 'added a connection' : `added ${edges} connections`)
  else if (edges < 0) parts.push(-edges === 1 ? 'removed a connection' : `removed ${-edges} connections`)
  else if (JSON.stringify(before.edges) !== JSON.stringify(after.edges)) parts.push('connections')
  for (const [key, label] of [['executionPolicy', 'workflow limits'], ['approval', 'approval handling'],
    ['executionCondition', 'start condition'], ['handoffs', 'work handoffs'], ['repeat', 'repeat blocks'],
    ['entryNodeId', 'starting node'], ['description', 'description']] as const) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) parts.push(label)
  }
  return parts.length ? parts.join(', ') : 'agent settings'
}
