import { useId, useMemo } from 'react'
import type { Agent, DurableInteraction } from '@foreman-code/contracts'
import { useInfiniteInteractionsQuery, useWorkspaceDetailsQuery } from '../../shared/api/query'
import { useUserInteractionResponse } from '../../shared/api/userApprovals'
import { approvalOptionScope } from '../../shared/ui/approvalOptionScope'
import { NativeInteractionResponse } from '../../shared/ui/NativeInteractionResponse'
import { Alert, Avatar, Button, ErrorState, Icon, IconButton, LoadingState } from '../../shared/ui/nocturne'
import { usePresence } from '../../shared/ui/usePresence'
import { raiseFloating, useFloatingZ } from '../../shared/ui/floatingStack'
import { interactionMatchesScope } from './approvalState'
import { summarizeApprovalRequest } from './approvalPresentation'
import { approvalResizeEdges, useApprovalInboxResize } from './useApprovalInboxResize'
import { APPROVAL_INBOX_STACK_ID, useApprovalInboxStore } from './approvalInboxStore'
import './approvals.css'


function QuickApprovalActions({ interaction, onChanged }: { interaction: DurableInteraction; onChanged(): void }) {
  const response = useUserInteractionResponse()
  if (interaction.kind === 'work_direction') return <div className="approval-row-actions">
    <NativeInteractionResponse options={interaction.responseOptions} disabled={response.isPending}
      onSelect={(optionId, values) => response.mutate({ interactionId: interaction.id, optionId,
        expectedRevision: interaction.revision, ...(values !== undefined ? { response: values } : {}) },
      { onSuccess: onChanged })} />
    {response.isError ? <span role="alert">{response.error.message}</span> : null}
  </div>
  if (interaction.harness === 'opencode') return <span>Retired harness (OpenCode): read-only</span>
  const approve = interaction.responseOptions.find((option) => option.semantic === 'approve_once')
    ?? interaction.responseOptions.find((option) => option.semantic === 'allow_turn')
  const reject = interaction.responseOptions.find((option) => option.semantic === 'reject')
    ?? interaction.responseOptions.find((option) => option.semantic === 'cancel')
  const send = (optionId: string) => response.mutate({ interactionId: interaction.id, optionId, expectedRevision: interaction.revision }, { onSuccess: onChanged })
  return <div className="approval-row-actions" aria-label={`Respond to ${summarizeApprovalRequest(interaction.request, interaction.nativeRequestType).operation}`}>
    {approve ? <Button size="sm" disabled={response.isPending} loading={response.isPending && response.variables?.optionId === approve.optionId}
      title={approvalOptionScope(approve)} onClick={() => send(approve.optionId)}>Accept</Button> : null}
    {reject ? <Button size="sm" variant="ghost" disabled={response.isPending} loading={response.isPending && response.variables?.optionId === reject.optionId}
      title={`${reject.scopeSummary ? `${reject.scopeSummary}. ` : ''}${approvalOptionScope(reject)}`} onClick={() => send(reject.optionId)}>Reject</Button> : null}
    {response.isError ? <span role="alert" className="approval-row-error">{response.error.message}</span> : null}
  </div>
}

function AgentProfileDisclosure({ agent }: { agent?: Agent }) {
  const id = useId()
  const name = agent?.name ?? 'Unknown agent'
  const harness = agent?.harness === 'opencode' ? 'Retired harness (OpenCode): read-only' : agent?.harness === 'codex' ? 'Codex' : agent?.harness === 'claude' ? 'Claude' : undefined
  return <span className="approval-agent-disclosure">
    <button type="button" className="approval-agent-button" aria-label={`Agent profile: ${name}`} aria-describedby={id}>
      <Avatar name={name} size="sm" />
    </button>
    <span id={id} role="tooltip" className="approval-hover-card approval-agent-hover-card">
      <strong>{name}</strong>
      <span>{[agent?.role ?? agent?.productRole, harness, agent?.model].filter(Boolean).join(' · ') || 'Agent'}</span>
      {agent?.description ? <small>{agent.description}</small> : null}
    </span>
  </span>
}

function RequestDetailDisclosure({ interaction }: { interaction: DurableInteraction }) {
  const id = useId()
  const summary = summarizeApprovalRequest(interaction.request, interaction.nativeRequestType)
  return <span className="approval-request-disclosure">
    <button type="button" className="approval-request-info" aria-label={`More details: ${summary.operation}`} aria-describedby={id}><Icon name="info" size={12} /></button>
    <span id={id} role="tooltip" className="approval-hover-card approval-request-hover-card">
      <strong>{summary.operation}</strong>
      <code>{summary.command ?? summary.target ?? summary.explanation ?? 'No additional details supplied.'}</code>
      {interaction.reviewContext ? <>
        <span><strong>Target:</strong> {interaction.reviewContext.target}</span>
        <span><strong>Proposed change:</strong> {interaction.reviewContext.changeSummary}</span>
      </> : null}
    </span>
  </span>
}

function RequestRow({ interaction, agent, onChanged }: {
  interaction: DurableInteraction
  agent?: Agent
  onChanged(): void
}) {
  const summary = summarizeApprovalRequest(interaction.request, interaction.nativeRequestType)
  return <li className="approval-request-row">
    <AgentProfileDisclosure agent={agent} />
    <span className="approval-request-label">{summary.operation}</span>
    <QuickApprovalActions interaction={interaction} onChanged={onChanged} />
    <RequestDetailDisclosure interaction={interaction} />
  </li>
}

function ApprovalInboxPanel({ open, exiting, resize }: {
  open: boolean
  exiting: boolean
  resize: ReturnType<typeof useApprovalInboxResize>
}) {
  const workspaceId = useApprovalInboxStore((state) => state.workspaceId)
  const workflowId = useApprovalInboxStore((state) => state.workflowId)
  const closeInbox = useApprovalInboxStore((state) => state.closeInbox)
  const { panelRef, style, moveGrip, grip } = resize
  const zIndex = useFloatingZ(APPROVAL_INBOX_STACK_ID, !exiting)
  const scope = { workspaceId: workspaceId || undefined, workflowId, limit: 100 }
  const queue = useInfiniteInteractionsQuery({ ...scope, status: 'pending' }, open && Boolean(workspaceId))
  const workspace = useWorkspaceDetailsQuery(workspaceId, { enabled: open && Boolean(workspaceId), retry: false })
  const interactions = useMemo(() => {
    const byId = new Map<string, DurableInteraction>()
    for (const page of queue.data?.pages ?? []) for (const item of page.items) {
      if (item.status !== 'pending' || item.approval.handler !== 'user' || !interactionMatchesScope(item, { workspaceId, workflowId })) continue
      const current = byId.get(item.id)
      if (!current || item.revision >= current.revision) byId.set(item.id, item)
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }, [queue.data?.pages, workspaceId, workflowId])
  const refetch = () => void queue.refetch()
  const agentFor = (interaction: DurableInteraction) => workspace.data?.agents.find((agent) => agent.id === interaction.requestingAgentId)
  return <div className="approval-inbox-root" style={{ zIndex }} onPointerDownCapture={() => raiseFloating(APPROVAL_INBOX_STACK_ID)}
    onFocusCapture={() => raiseFloating(APPROVAL_INBOX_STACK_ID)}>
    <section ref={panelRef} style={style} className="approval-inbox-panel" data-state={exiting ? 'closing' : 'open'} role="dialog" aria-modal="false" aria-label="Human approval inbox"
      aria-hidden={exiting} inert={exiting}
      onKeyDown={(event) => { if (event.key === 'Escape') closeInbox() }}>
      {approvalResizeEdges.map((edge) => <button key={edge} type="button" className={`approval-inbox-resize approval-inbox-resize-${edge}`} {...grip(edge)} />)}
      <button type="button" className="approval-inbox-move" title="Drag to move approval inbox" {...moveGrip} />
      <div className="approval-inbox-controls">
        <IconButton label="Close approval inbox" variant="ghost" onClick={closeInbox}><Icon name="close" /></IconButton>
      </div>
      <div className="approval-inbox-body">
        <main>
          {queue.isError ? <ErrorState title="Requests unavailable" description={queue.error.message} onRetry={refetch} retrying={queue.isFetching} /> : null}
          {queue.isPending ? <LoadingState label="Loading human approvals…" rows={4} /> : null}
          {!queue.isPending && !queue.isError && interactions.length === 0 ? <p className="approval-empty">No requests yet.</p> : null}
          {interactions.length ? <ol className="approval-request-list">{interactions.map((interaction) => <RequestRow key={interaction.id} interaction={interaction}
            agent={agentFor(interaction)} onChanged={refetch} />)}</ol> : null}
          {queue.hasNextPage ? <Button size="sm" disabled={queue.isFetchingNextPage} loading={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>Load more</Button> : null}
          {queue.isFetchNextPageError ? <Alert live tone="danger" title="More requests could not be loaded">Try Load more again.</Alert> : null}
        </main>
      </div>
    </section>
  </div>
}

export function ApprovalInbox() {
  const open = useApprovalInboxStore((state) => state.open)
  const presence = usePresence(open)
  const resize = useApprovalInboxResize()
  return presence.mounted ? <ApprovalInboxPanel open={open} exiting={presence.exiting} resize={resize} /> : null
}
