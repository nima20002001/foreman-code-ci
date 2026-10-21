import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Select } from '../../shared/ui/nocturne'
import { useChatWindowsStore } from '../conversations/agentChat/agentChatWindows'
import type { AgentPanelRenderer, PinnedPanelNode } from '../graph/nextDraft/DraftCanvas'
import { useWorkflowBoard } from './context'

/** Existing Agent components retain their stores; only their frame changes. */
const noChats: readonly string[] = []
export function WorkflowAgentPanel({ panels, findNode, nodes, chatScope, active = true }: {
  panels: AgentPanelRenderer
  findNode(nodeId: string): PinnedPanelNode | false | undefined
  nodes: readonly { id: string; name: string }[]
  chatScope: string
  active?: boolean
}) {
  const board = useWorkflowBoard()
  const selection = board?.sidePanel
  const chats = useChatWindowsStore(state => state.open[chatScope] ?? noChats)
  const adopted = useRef(false)
  useEffect(() => {
    if (!active || !board?.selectSidePanel || adopted.current) return
    adopted.current = true
    const nodeId = chats.filter(id => nodes.some(node => node.id === id)).at(-1)
    if (selection?.kind === 'none' && !board.selectedPanelNodeId && nodeId) {
      board.selectSidePanel({ kind: 'agent', nodeId, tab: 'chat' })
    }
  }, [active, board, chats, nodes, selection])
  if (!active || !board?.sidePanelHost || board.memoryOpen || selection?.kind !== 'agent'
    || selection.executionId) return null
  const node = findNode(selection.nodeId)
  const body = node === false ? <p role="status">This node is not available in the selected workflow or Run.</p>
    : panels(selection.nodeId, node)[selection.tab === 'details' ? 'info' : selection.tab]
  const choices = [...new Set([...chats, selection.nodeId])].map(id => ({ value: id,
    label: nodes.find(node => node.id === id)?.name ?? `${id} (unavailable)` }))
  return createPortal(<>
    {choices.length > 1 ? <Select label="Agent" value={selection.nodeId} options={choices}
      onChange={event => board.selectSidePanel?.({ kind: 'agent', nodeId: event.target.value, tab: selection.tab })} /> : null}
    {body}
  </>, board.sidePanelHost)
}
