import type { MemoryCard as Card } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import type { MemoryNodeOption } from './ports'
import { nodeLabel, visibleTime } from './presentation'
import './memoryBoards.css'

/** One card, styled by its status; reusable outside the Memory board columns. */
export function MemoryCard({ card, nodes, onOpen }: { card: Card; nodes: readonly MemoryNodeOption[]; onOpen(): void }) {
  const waiting = card.status === 'waiting_for_user'
  return <article className="memory-card" data-status={card.status}>
    {waiting && <p className="memory-card-flag">Needs you</p>}
    <Button variant="ghost" className="memory-card-title" onClick={onOpen}>{card.title}</Button>
    {card.reason && <p className="memory-card-reason">
      {waiting && <span className="memory-card-reason-label">To do: </span>}{card.reason}</p>}
    <p className="memory-card-meta">
      <span className="memory-card-owner">{card.assignee ? nodeLabel(card.assignee, nodes) : 'Unassigned'}</span>
      {card.status === 'done' && <span className="memory-card-outcome">{card.completionKind === 'dropped' ? 'Dropped' : 'Completed'}</span>}
      <small>Updated {visibleTime(card.updatedAt)}</small>
    </p>
  </article>
}
