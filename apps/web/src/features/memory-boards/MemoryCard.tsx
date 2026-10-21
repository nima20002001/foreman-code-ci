import type { MemoryCard as Card } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import type { MemoryNodeOption } from './ports'
import { nodeLabel, visibleTime } from './presentation'

export function MemoryCard({ card, nodes, onOpen }: { card: Card; nodes: readonly MemoryNodeOption[]; onOpen(): void }) {
  return <article className="memory-card">
    <Button variant="ghost" className="memory-card-title" onClick={onOpen}>{card.title}</Button>
    <p className="memory-card-owner">{card.assignee ? nodeLabel(card.assignee, nodes) : 'Unassigned'}</p>
    {card.status === 'done' && <p>{card.completionKind === 'dropped' ? 'Dropped' : 'Completed'}</p>}
    {card.reason && <p className="memory-card-reason">{card.reason}</p>}
    <small>Updated {visibleTime(card.updatedAt)}</small>
  </article>
}
