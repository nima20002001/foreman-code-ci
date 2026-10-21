import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefCallback, type RefObject } from 'react'
import type { BoardSidePanel } from '@foreman-code/contracts/wave25'
import type { HierarchyReport } from '@foreman-code/contracts'
import { Button, Dialog, Slider } from '../../shared/ui/nocturne'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { useSidePanelPresentation, useSidePanelScroll } from './sidePanelPresentation'
import type { CollaborationFieldSlots } from '../graph/collaborationFields'
import type { WorkflowExecutionChatSlotSelection } from '../workflow-hierarchy/execution-chat/types'

export interface WorkflowCollaborationSlots extends CollaborationFieldSlots {
  groupChat?(scope: { workspaceId: string; workflowId: string; runId?: string }): ReactNode
  /** URL-owned selection. F3 resolves it through the canonical delivery target service. */
  executionChat?(selection: WorkflowExecutionChatSlotSelection): ReactNode
  browser?(selection: Extract<BoardSidePanel, { kind: 'browser' }> & {
    workspaceId: string; workflowId: string; runId?: string; workflowVersionId?: string
  }): ReactNode
  /** B retains exact release identity and minimal reconciliation after its body unmounts. */
  beforeBrowserHide?(): void | Promise<void>
  browserRecovery?(): ReactNode
  overview?(): ReactNode
  memoryBoard?(): ReactNode
  reportCard?(cardId: string, report: HierarchyReport): void
}

export interface WorkflowSidePanelProps {
  scope: string
  workspaceId: string
  workflowId: string
  runId?: string
  workflowVersionId?: string
  opener: RefObject<HTMLElement | null>
  selection: BoardSidePanel
  agentSelection?: Extract<BoardSidePanel, { kind: 'agent' }>
  onSelect(selection: BoardSidePanel): void
  onSelectTarget: WorkflowExecutionChatSlotSelection['onSelectTarget']
  onSelectRun: WorkflowExecutionChatSlotSelection['onSelectRun']
  bodyRef: RefCallback<HTMLDivElement>
  modalOpen: boolean
  slots?: WorkflowCollaborationSlots
}

const destinations = [['agent', 'Agent'], ['browser', 'Browser']] as const

/** Only the selected body mounts. The fixed portal host preserves existing conversation/store ownership. */
export function WorkflowSidePanel({ scope, workspaceId, workflowId, runId, workflowVersionId,
  opener, selection, agentSelection, onSelect, onSelectTarget, onSelectRun, bodyRef, modalOpen, slots }: WorkflowSidePanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const heldFocus = useRef(false)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const width = useSidePanelPresentation(state => state.widths[scope] ?? 420)
  const conversationId = useOperatorChatStore(state => state.selectedConversationId)
  const attach = useCallback((element: HTMLDivElement | null) => { setHost(element); bodyRef(element) }, [bodyRef])
  useSidePanelScroll(host, JSON.stringify([scope, runId, selection,
    selection.kind === 'operator' ? conversationId : undefined]), modalOpen)
  // Group chat opens in its own resizable dialog, never in this rail.
  const groupChat = selection.kind === 'group_chat'
  const active = selection.kind !== 'none' && !groupChat
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) return
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    const viewport = window.visualViewport
    const resize = () => {
      const top = viewport?.offsetTop ?? 0
      const bottom = top + (viewport?.height ?? window.innerHeight)
      panel.style.maxHeight = `${Math.max(0, bottom - Math.max(top, panel.getBoundingClientRect().top))}px`
    }
    resize()
    window.addEventListener('resize', resize)
    viewport?.addEventListener('resize', resize)
    viewport?.addEventListener('scroll', resize)
    return () => {
      window.removeEventListener('resize', resize)
      viewport?.removeEventListener('resize', resize)
      viewport?.removeEventListener('scroll', resize)
    }
  }, [active, modalOpen])
  useEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) {
      heldFocus.current = false
      return
    }
    if (document.activeElement && document.activeElement !== document.body) {
      heldFocus.current = panel.contains(document.activeElement)
    }
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const focused = document.activeElement
      const inside = panel.contains(focused)
      const orphaned = heldFocus.current && (!focused || focused === document.body)
      if (!(inside || orphaned) || document.querySelector('dialog[open]')
        || focused?.closest('[role="listbox"], .n-menu')) return
      event.preventDefault()
      event.stopPropagation()
      onSelect({ kind: 'none' })
    }
    const rememberFocus = (event: FocusEvent) => {
      heldFocus.current = panel.contains(event.target as Node | null)
    }
    // A removed focused portal control leaves focus on body; other surfaces retain their own Escape.
    document.addEventListener('keydown', close)
    document.addEventListener('focusin', rememberFocus)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('focusin', rememberFocus)
    }
  }, [active, modalOpen, onSelect])
  useEffect(() => {
    if (!active) return
    const openedFrom = opener.current
    return () => { if (openedFrom?.isConnected) openedFrom.focus() }
  }, [active, opener])
  const content = modalOpen ? null : selection.kind === 'browser'
      ? slots?.browser?.({ ...selection, workspaceId, workflowId, ...(runId ? { runId } : {}),
        ...(workflowVersionId ? { workflowVersionId } : {}) }) ?? <p role="status">Browser is not available yet. No browser session has been started.</p>
      : selection.kind === 'agent' && selection.tab === 'chat'
        ? slots?.executionChat?.({ workspaceId, workflowId, ...(runId ? { runId } : {}),
          onSelectTarget, onSelectRun,
          ...(workflowVersionId ? { workflowVersionId } : {}), nodeId: selection.nodeId,
          ...(selection.executionId ? { executionId: selection.executionId } : {}),
          ...(selection.waitingActivationId ? { waitingActivationId: selection.waitingActivationId } : {}) })
          ?? (selection.executionId || selection.waitingActivationId ? <p role="status">Chat for this selected execution is not available yet. Your execution selection is kept.</p> : null)
        : null
  return <><Dialog open={groupChat && !modalOpen} onOpenChange={open => { if (!open) onSelect({ kind: 'none' }) }}
    title="Group chat" closeLabel="Close group chat" className="workflow-group-chat-dialog">
    {groupChat && !modalOpen ? slots?.groupChat?.({ workspaceId, workflowId, ...(runId ? { runId } : {}) })
      ?? <p role="status">Group chat is not available yet.</p> : null}
  </Dialog>
  <aside ref={panelRef} tabIndex={-1} className="workflow-side-panel" aria-label="Workflow side panel"
    style={{ '--workflow-rail-width': `${width}px` } as CSSProperties}
    hidden={!active || modalOpen} inert={!active || modalOpen}>
    <header>
      <h2>{selection.kind === 'operator' ? 'Operator' : selection.kind === 'browser' ? 'Browser' : 'Agent'}</h2>
      <Button size="sm" variant="ghost" onClick={() => onSelect({ kind: 'none' })}>Back to Board</Button>
    </header>
    <nav aria-label="Workflow panel destination">
      {destinations.map(([kind, label]) => <Button key={kind} size="sm" variant="ghost"
        aria-pressed={selection.kind === kind} disabled={kind === 'agent' && !agentSelection}
        onClick={() => {
          if (kind === 'agent') { if (agentSelection) onSelect(agentSelection) }
          else onSelect({ kind })
        }}>{label}</Button>)}
    </nav>
    {!agentSelection ? <p className="workflow-panel-hint">Select a node on the Board to open Agent chat or settings.</p> : null}
    {selection.kind === 'agent' ? <nav aria-label="Agent panel view">
      {(['chat', 'settings', 'details'] as const).map(tab => <Button key={tab} size="sm" variant="ghost"
        aria-pressed={selection.tab === tab} onClick={() => onSelect({ ...selection, tab })}>
        {tab === 'chat' ? 'Chat' : tab === 'settings' ? 'Settings' : 'Details'}</Button>)}
    </nav> : null}
    <div className="workflow-rail-size"><Slider label="Panel width" min={320} max={640} value={width}
      onValueChange={value => useSidePanelPresentation.getState().setWidth(scope, value)} format={value => `${value} px`} /></div>
    <div className="workflow-side-panel-body" ref={attach}>{modalOpen ? null : content}</div>
  </aside></>
}

export function WorkflowMemoryDialog({ open, onOpenChange, slots }: {
  open: boolean; onOpenChange(open: boolean): void; slots?: WorkflowCollaborationSlots
}) {
  return <Dialog open={open} onOpenChange={onOpenChange} title="Memory board" closeLabel="Close Memory board">
    {open ? slots?.memoryBoard?.() ?? <p role="status">Memory board is not available yet.</p> : null}
  </Dialog>
}
