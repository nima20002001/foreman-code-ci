import { useState } from 'react'
import type { MemoryCard as Card, MemoryCardWorkBinding } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { useMemoryCardDetail, useMemoryHistory, useMemoryBindings, useMemoryClaims } from './queries'
import type { MemoryBoardClient, MemoryCardDetail as Detail, MemoryChange, MemoryNodeOption, MemoryWorkHealth } from './ports'
import { bindingLabel, errorMessage, nodeLabel, statusLabels, visibleTime } from './presentation'

export type MemoryCardAction = 'edit' | 'drop' | 'reopen' | 'resolve_reopen' | 'resolve_drop'
interface Props {
  client: MemoryBoardClient
  boardId: string
  cardId: string
  nodes: readonly MemoryNodeOption[]
  health: readonly MemoryWorkHealth[]
  canWrite: boolean
  onBack(): void
  onEdit(card: Card, action: MemoryCardAction): void
  onOpenWork(binding: MemoryCardWorkBinding): void
  onSourcePost?(postId: string): void
  onOpenHistoryWork?(change: MemoryChange): void
}
export function MemoryCardDetail({ client, boardId, cardId, ...props }: Props) {
  const query = useMemoryCardDetail(client, boardId, cardId)
  if (!query.data) return <section className="n-stack" aria-label="Card detail">
    <Button onClick={props.onBack}>Back to Memory board</Button>
    {query.isError ? <><p role="alert">Couldn’t load this card. {errorMessage(query.error)}</p><Button onClick={() => void query.refetch()}>Retry</Button></>
      : <p role="status">Loading card…</p>}
  </section>
  return <CardDetailBody {...props} client={client} detail={query.data} stale={query.isError} retry={() => void query.refetch()} />
}
function CardDetailBody({ detail, client, nodes, health, canWrite, onEdit, onOpenWork, onSourcePost, onOpenHistoryWork, onBack, stale, retry }: Omit<Props, 'boardId' | 'cardId'> & {
  detail: Detail; stale: boolean; retry(): void
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const history = useMemoryHistory(client, detail, historyOpen)
  const card = detail.card
  const bindings = useMemoryBindings(client, detail)
  const claims = useMemoryClaims(client, detail)
  const terminalBlocker = detail.workSummary.unresolvedFailures > 0
  return <section className="n-stack memory-detail" aria-label="Card detail">
    <Button onClick={onBack}>Back to Memory board</Button>
    <h3>{card.title}</h3>
    {stale && <p role="status">Couldn’t refresh this card. <Button size="sm" onClick={retry}>Retry</Button></p>}
    <p>{statusLabels[card.status]}{card.status === 'done' ? ` · ${card.completionKind === 'dropped' ? 'Dropped' : 'Completed'}` : ''}</p>
    <p className="memory-preserve-lines">{card.body || 'No details added.'}</p>
    {card.reason && <p><strong>Reason:</strong> {card.reason}</p>}
    <p><strong>Owner:</strong> {card.assignee ? nodeLabel(card.assignee, nodes) : 'Unassigned'}</p>
    {card.linkedNodes.length > 0 && <div><h4>Linked nodes</h4><ul>{card.linkedNodes.map((node) =>
      <li key={`${node.workflowId}/${node.workflowNodeId}/${node.agentId}`}>{nodeLabel(node, nodes)}</li>)}</ul></div>}
    <div><h4>Linked work</h4>
      <p>{detail.workSummary.activeBindings} active obligations · {detail.workSummary.armedClaims} next-activation claims</p>
      {detail.bindings.length === 0 && detail.claims.length === 0 && <p>No work obligations. Assigning an owner does not start an agent.</p>}
      <ul className="memory-work-list">{bindings.data.pages.flatMap(page => page.items).map((binding) => {
        const currentHealth = health.find((item) => item.bindingId === binding.id)
        return <li key={binding.id}>
          <strong>{nodeLabel(binding.node, nodes)}</strong>
          <p>Run {binding.work.runId.slice(0, 8)} · {bindingLabel(binding)}{currentHealth?.continuing ? ' · Continuing task' : ''}</p>
          {currentHealth?.stopping && <p>Waiting for turn to stop</p>}
          {binding.reason && <p>{binding.reason}</p>}
          {currentHealth && currentHealth.state !== 'online' && <p>{currentHealth.state === 'offline' ? 'Computer offline' : 'Computer status unconfirmed'}
            {currentHealth.lastSeenAt ? ` · Last seen ${visibleTime(currentHealth.lastSeenAt)}` : ''}; work status unconfirmed.</p>}
          {binding.resolution && <p>Resolved by {binding.resolution.kind === 'reopened' ? 'reopening' : 'dropping'}: {binding.resolution.reason}. Original outcome: {binding.state}.</p>}
          <Button size="sm" onClick={() => onOpenWork(binding)}>Open work</Button>
        </li>
      })}{claims.data.pages.flatMap(page => page.items).map((claim) => <li key={claim.id}>Next activation · {nodeLabel(claim.node, nodes)} · {claim.state}</li>)}</ul>
      {bindings.isError && <p role="alert">Couldn’t load linked work. <Button onClick={() => void bindings.refetch()}>Retry linked work</Button></p>}
      {claims.isError && <p role="alert">Couldn’t load activation claims. <Button onClick={() => void claims.refetch()}>Retry claims</Button></p>}
      {bindings.hasNextPage && <Button loading={bindings.isFetchingNextPage} loadingLabel="Loading linked work…"
        onClick={() => void bindings.fetchNextPage()}>Load more linked work</Button>}
      {claims.hasNextPage && <Button loading={claims.isFetchingNextPage} loadingLabel="Loading activation claims…"
        onClick={() => void claims.fetchNextPage()}>Load more activation claims</Button>}
    </div>
    {card.sourcePostId && <Button onClick={() => onSourcePost?.(card.sourcePostId!)} disabled={!onSourcePost}>Source message</Button>}
    <div className="n-actions">
      <Button disabled={!canWrite} onClick={() => onEdit(card, 'edit')}>Edit</Button>
      {card.status === 'done' ? <Button disabled={!canWrite} onClick={() => onEdit(card, 'reopen')}>Reopen in Todo</Button>
        : <Button disabled={!canWrite} onClick={() => onEdit(card, 'drop')}>Drop card</Button>}
      {terminalBlocker && <><Button disabled={!canWrite} onClick={() => onEdit(card, 'resolve_reopen')}>Resolve and reopen</Button>
        <Button disabled={!canWrite} onClick={() => onEdit(card, 'resolve_drop')}>Resolve and drop</Button></>}
    </div>
    <Button onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>History</Button>
    {historyOpen && <div>
      {history.isError && <p role="alert">Couldn’t load history. <Button onClick={() => void history.restart()}>Retry</Button></p>}
      <ol>{history.data?.pages.flatMap((page) => page.items).map((entry) => <HistoryEntry key={entry.id} entry={entry} onOpenWork={onOpenHistoryWork} />)}</ol>
      {history.hasNextPage && <Button loading={history.isFetchingNextPage} loadingLabel="Loading history…" onClick={() => void history.fetchNextPage()}>Load more history</Button>}
    </div>}
  </section>
}
function HistoryEntry({ entry, onOpenWork }: { entry: MemoryChange; onOpenWork?: (change: MemoryChange) => void }) {
  const text = (value: unknown) => typeof value === 'string' ? value : value === null || value === undefined ? 'None' : JSON.stringify(value)
  return <li>{entry.actor.displayName} updated this card · {visibleTime(entry.occurredAt)}
    {entry.changes && <ul>{Object.entries(entry.changes).map(([field, change]) => <li key={field}>
      <details><summary>{field} changed</summary><p className="memory-preserve-lines">Previously: {text(change.before)}</p>
        <p className="memory-preserve-lines">Saved: {text(change.after)}</p></details>
    </li>)}</ul>}
    {entry.provenance?.work && <p>Run {entry.provenance.work.runId.slice(0, 8)}
      {entry.provenance.execution ? ` · Execution ${entry.provenance.execution.executionId.slice(0, 8)}` : ''}
      {onOpenWork && <Button size="sm" onClick={() => onOpenWork(entry)}>Open recorded work</Button>}</p>}
    {entry.provenance?.subject?.kind === 'coordinator_consultation' && <p>Consultation · {entry.provenance.subject.agent.displayName}</p>}
  </li>
}
