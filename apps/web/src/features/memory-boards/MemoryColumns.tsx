import { useEffect, useState } from 'react'
import type { MemoryCard as Card } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { SearchField, Select } from '../../shared/ui/nocturne/Fields'
import { mergedMemoryItems, useMemoryCards } from './queries'
import { MemoryCard } from './MemoryCard'
import { statusLabels } from './presentation'
import type { MemoryBoardClient, MemoryBoardView, MemoryFilters, MemoryNodeOption } from './ports'

export function MemoryColumns({ client, board, nodes, filters, onFiltersChange, onOpenCard, onAdd, canWrite }: {
  client: MemoryBoardClient; board: MemoryBoardView; nodes: readonly MemoryNodeOption[]; filters: MemoryFilters
  onFiltersChange(filters: MemoryFilters): void; onOpenCard(cardId: string): void; onAdd(): void; canWrite: boolean
}) {
  const [search, setSearch] = useState(filters.query)
  useEffect(() => { setSearch(filters.query) }, [filters.query])
  useEffect(() => {
    if (search === filters.query) return
    const timer = setTimeout(() => onFiltersChange({ ...filters, query: search }), 250)
    return () => clearTimeout(timer)
  }, [search, filters, onFiltersChange])
  return <section aria-label="Cards" className="n-stack">
    <div className="memory-filter-row">
      <SearchField label="Find cards" hint="Title starts with…" maxLength={240} value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
      {search && <Button onClick={() => { setSearch(''); onFiltersChange({ ...filters, query: '' }) }}>Clear search</Button>}
      <Select label="Status" value={filters.status ?? ''} options={[{ value: '', label: 'All statuses' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))]}
        onChange={(event) => onFiltersChange({ ...filters, status: event.currentTarget.value as Card['status'] || undefined,
          doneOpen: filters.doneOpen || event.currentTarget.value === 'done' })} />
      <Button disabled={!canWrite} variant="primary" onClick={onAdd}>Add card</Button>
    </div>
    {filters.query && <p className="n-field-hint">Sorted by title</p>}
    <div className="memory-columns" role="region" aria-label="Memory card columns" tabIndex={0}>
      {(Object.keys(statusLabels) as Card['status'][]).map((status) => <Column key={status} client={client} board={board} nodes={nodes}
        status={status} filters={filters} onFiltersChange={onFiltersChange} onOpenCard={onOpenCard} />)}
    </div>
  </section>
}
function Column({ client, board, nodes, status, filters, onFiltersChange, onOpenCard }: {
  client: MemoryBoardClient; board: MemoryBoardView; nodes: readonly MemoryNodeOption[]; status: Card['status']; filters: MemoryFilters
  onFiltersChange(filters: MemoryFilters): void; onOpenCard(cardId: string): void
}) {
  const shown = !filters.status || filters.status === status
  const open = shown && (status !== 'done' || filters.doneOpen)
  const query = useMemoryCards(client, board, { status, query: filters.query || undefined,
    completionKind: status === 'done' ? filters.completionKind : undefined }, open)
  const cards = mergedMemoryItems(query.data?.pages)
  return <section className="memory-column" data-status={status} aria-label={statusLabels[status]}>
    <h3 className="memory-column-heading"><span className="memory-status-dot" aria-hidden="true" />{statusLabels[status]}
      {!filters.query && <span className="memory-column-count" aria-label={`${board.counts[status]} cards`}>{board.counts[status]}</span>}</h3>
    {!shown ? <p>Hidden by status filter</p> : status === 'done' && !filters.doneOpen ? <Button onClick={() => onFiltersChange({ ...filters, doneOpen: true })}>Show Done</Button> : <>
      {status === 'done' && <Select label="Done outcome" value={filters.completionKind ?? ''}
        options={[{ value: '', label: 'All' }, { value: 'completed', label: 'Completed' }, { value: 'dropped', label: 'Dropped' }]}
        onChange={(event) => onFiltersChange({ ...filters, completionKind: event.currentTarget.value as 'completed' | 'dropped' || undefined })} />}
      {query.isPending && <p role="status">Loading cards…</p>}
      {query.isError && <p role="alert">Couldn’t load cards. <Button size="sm" onClick={() => void query.restart()}>Retry</Button></p>}
      {filters.query && query.isSuccess && <p>{cards.length} matching cards shown{query.hasNextPage ? ' · More matches available' : ''}</p>}
      {query.isSuccess && cards.length === 0 && !query.hasNextPage && <p>{filters.query ? 'No matching cards' : 'No cards yet'}</p>}
      {cards.map((card) => <MemoryCard key={card.id} card={card} nodes={nodes} onOpen={() => onOpenCard(card.id)} />)}
      {query.hasNextPage && <Button loading={query.isFetchingNextPage} loadingLabel="Loading cards…" onClick={() => void query.fetchNextPage()}>Load more {statusLabels[status]}</Button>}
      {query.isSuccess && cards.length === 0 && query.hasNextPage && <Button onClick={() => void query.fetchNextPage()}>Load cards</Button>}
    </>}
  </section>
}
