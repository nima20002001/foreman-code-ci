import { useState } from 'react'
import type { MemoryNote } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { mergedMemoryItems, useMemoryNotes } from './queries'
import type { MemoryBoardClient, MemoryBoardView } from './ports'
import { errorMessage } from './presentation'

export function NotesStrip({ client, board, canWrite, onAdd, onEdit, onArchive, onSourcePost }: {
  client: MemoryBoardClient; board: MemoryBoardView; canWrite: boolean
  onAdd(): void; onEdit(note: MemoryNote): void; onArchive(note: MemoryNote, archived: boolean): void
  onSourcePost?(postId: string): void
}) {
  const [archived, setArchived] = useState(false)
  const query = useMemoryNotes(client, board, archived)
  const notes = mergedMemoryItems(query.data?.pages).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
  return <section className="memory-notes" aria-label="Notes">
    <div className="n-between"><h3>{archived ? 'Archived notes' : 'Notes'}</h3><div className="n-actions">
      <Button size="sm" disabled={!canWrite} onClick={onAdd}>Add note</Button>
      <Button size="sm" onClick={() => setArchived(!archived)}>{archived ? 'Active notes' : 'Archived notes'}</Button>
    </div></div>
    {query.isPending && <p role="status">Loading notes…</p>}
    {query.isError && <p role="alert">Couldn’t load notes. {errorMessage(query.error)} <Button size="sm" onClick={() => void query.restart()}>Retry</Button></p>}
    {query.isSuccess && !notes.length && <p>{archived ? 'No archived notes.' : 'Keep facts agents should remember'}</p>}
    <div className="memory-notes-list">{notes.map((note) => <article key={note.id} className="memory-note">
      <NoteText text={note.text} />
      <div className="n-actions"><Button size="sm" disabled={!canWrite} onClick={() => onEdit(note)}>Edit note</Button>
        <Button size="sm" disabled={!canWrite} onClick={() => onArchive(note, !archived)}>{archived ? 'Restore' : 'Archive note'}</Button>
        {note.sourcePostId && <Button size="sm" disabled={!onSourcePost} onClick={() => onSourcePost?.(note.sourcePostId!)}>Source message</Button>}
      </div>
    </article>)}</div>
    {query.hasNextPage && <Button loading={query.isFetchingNextPage} loadingLabel="Loading notes…" onClick={() => void query.fetchNextPage()}>Load more notes</Button>}
  </section>
}
function NoteText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return <div><p className="memory-preserve-lines">{expanded || text.length <= 300 ? text : `${text.slice(0, 300)}…`}</p>
    {text.length > 300 && <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</Button>}</div>
}
