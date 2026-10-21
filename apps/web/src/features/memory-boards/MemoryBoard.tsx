import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryBoardMutation, MemoryBoardScope, MemoryCard as Card, MemoryCardWorkBinding } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne/Button'
import { useMemoryBoard } from './queries'
import { useMemorySave } from './commandRecovery'
import { memoryDraftMatchesCommand } from './draftReceipt'
import { useMemoryDraft, setMemoryDraft, newCardDraft, editCardDraft, editNoteDraft } from './drafts'
import { MemoryCardEditor } from './MemoryCardEditor'
import { MemoryNoteEditor } from './MemoryNoteEditor'
import { MemoryCardDetail, type MemoryCardAction } from './MemoryCardDetail'
import { MemorySaveStatus } from './MemorySaveStatus'
import { MemoryColumns } from './MemoryColumns'
import { NotesStrip } from './NotesStrip'
import { errorMessage, visibleTime } from './presentation'
import type { MemoryBoardClient, MemoryBoardView, MemoryChange, MemoryFilters, MemoryNodeOption, MemoryWorkHealth } from './ports'
import './memoryBoards.css'

export interface MemoryBoardInteraction {
  pending: boolean
  dirty: boolean
  requestLeave(proceed: () => void): void
}
export interface MemoryBoardProps {
  client: MemoryBoardClient
  scope: MemoryBoardScope
  scopeName: string
  visible?: boolean
  canWrite: boolean
  restriction?: string
  nodes: readonly MemoryNodeOption[]
  health?: readonly MemoryWorkHealth[]
  selectedCardId?: string
  onSelectCard(cardId: string | undefined): void
  filters: MemoryFilters
  onFiltersChange(filters: MemoryFilters): void
  onOpenWork(binding: MemoryCardWorkBinding): void
  onSourcePost?(postId: string): void
  onOpenHistoryWork?(change: MemoryChange): void
  onInteractionChange?(interaction: MemoryBoardInteraction | undefined): void
  sourceDraft?: { kind: 'card' | 'note'; postId: string; requestId: string }
  onSourceDraftConsumed?(): void
}
/** The shell owns section/card/filter URLs. This body creates no second router,
 * rail, transcript store or background subscription when hidden. */
export function MemoryBoard(props: MemoryBoardProps) {
  if (props.visible === false) return null
  const scopeKey = `${props.scope.workspaceId}/${props.scope.kind === 'workflow' ? props.scope.workflowId : 'workspace'}`
  return <VisibleMemoryBoard key={scopeKey} {...props} />
}
function VisibleMemoryBoard(props: MemoryBoardProps) {
  const live = useMemoryBoard(props.client, props.scope)
  const query = live.snapshot
  const error = live.identity.error ?? query.error
  const stale = live.connection === 'offline' || live.connection === 'reconnecting'
  return <section className="memory-board n-stack" aria-label={`${props.scopeName} memory board`}>
    <header><h2>{props.scopeName} · Memory board</h2>
      {query.data && (stale || error) && <p role="status">{live.connection === 'offline' ? 'Offline' : error ? 'Couldn’t refresh' : 'Reconnecting…'}
        {' · Last updated '}{visibleTime(query.dataUpdatedAt)} <Button size="sm" onClick={() => void live.retry()}>Retry</Button></p>}
      {live.connection === 'unavailable' && <p role="status">Live updates are unavailable. <Button size="sm" onClick={() => void live.retry()}>Refresh memory</Button></p>}
    </header>
    {!query.data ? error ? <div><p role="alert">Couldn’t load memory board. {errorMessage(error)}</p><Button onClick={() => void live.retry()}>Retry</Button></div>
      : <p role="status">Loading memory board…</p>
      : <BoardBody {...props} key={query.data.board.id} board={query.data} online={live.connection !== 'offline'} />}
  </section>
}
function BoardBody(props: MemoryBoardProps & { board: MemoryBoardView; online: boolean }) {
  const { board, client, nodes, onInteractionChange, onSelectCard, sourceDraft, onSourceDraftConsumed } = props
  const boardId = board.board.id
  const draft = useMemoryDraft(boardId), save = useMemorySave(client, boardId)
  const [leaveAction, setLeaveAction] = useState<(() => void)>()
  const consumedSource = useRef<string | undefined>(undefined)
  const matchesConfirmedDraft = Boolean(save.data && memoryDraftMatchesCommand(draft, save.confirmedCommand))
  const confirmedDraft = matchesConfirmedDraft && save.data?.outcome !== 'existing'
  const dirty = Boolean(draft?.dirty && !save.retained.command)
  useUnsavedChanges({ label: `${props.scopeName} memory board`, scope: 'surface', dirty,
    busy: save.isPending, uncertain: Boolean(save.retained.command), saveDisabled: true,
    save() { throw new Error('Save the card or note in the memory board before leaving.') },
    discard() { setMemoryDraft(boardId) },
  }, (current, next) => current.pathname !== next.pathname || current.search.workflowId !== next.search.workflowId
    || current.search.boardMemory === true && next.search.boardMemory !== true)
  const requestLeave = useCallback((proceed: () => void) => {
    if (save.isPending) return
    if (dirty) setLeaveAction(() => proceed)
    else proceed()
  }, [dirty, save.isPending])
  useEffect(() => {
    onInteractionChange?.({ pending: save.isPending, dirty, requestLeave })
    return () => onInteractionChange?.(undefined)
  }, [onInteractionChange, save.isPending, dirty, requestLeave])
  useEffect(() => {
    if (!sourceDraft || consumedSource.current === sourceDraft.requestId || draft || save.retained.command || save.isPending) return
    consumedSource.current = sourceDraft.requestId
    setMemoryDraft(boardId, sourceDraft.kind === 'card' ? newCardDraft(sourceDraft.postId) : editNoteDraft(undefined, sourceDraft.postId))
    onSourceDraftConsumed?.()
  }, [sourceDraft, draft, boardId, onSourceDraftConsumed, save.retained.command, save.isPending])
  useEffect(() => {
    if (!matchesConfirmedDraft) return
    if (save.data?.outcome !== 'existing') setMemoryDraft(boardId)
    if (save.data?.card && props.selectedCardId !== save.data.card.id) onSelectCard(save.data.card.id)
  }, [matchesConfirmedDraft, boardId, save.data, props.selectedCardId, onSelectCard])
  const canWrite = props.canWrite && props.online && save.retained.checked && !save.retained.error && !save.retained.command && !save.isPending && !confirmedDraft
  const openDraft = (next: NonNullable<typeof draft>) => requestLeave(() => {
    save.reset(); setMemoryDraft(boardId, next); onSelectCard(undefined)
  })
  const finishEditor = () => requestLeave(() => { setMemoryDraft(boardId); onSelectCard(undefined); save.reset() })
  const submit = (command: MemoryBoardMutation) => save.save(command)
  const edit = (card: Card, action: MemoryCardAction) => {
    const next = editCardDraft(card)
    if (action === 'drop' || action === 'resolve_drop') {
      next.fields = { ...next.fields, status: 'done', completionKind: 'dropped', reason: null }
      next.dirty = true
    } else if (action === 'reopen' || action === 'resolve_reopen') {
      next.fields = { ...next.fields, status: 'todo', completionKind: null, reason: null }
      next.dirty = true
    }
    next.resolutionRequired = action.startsWith('resolve_')
    openDraft(next)
  }
  const openCard = (cardId: string) => {
    if (save.data?.outcome === 'existing' || save.error) onSelectCard(cardId)
    else requestLeave(() => { setMemoryDraft(boardId); onSelectCard(cardId) })
  }
  return <div className="n-stack">
    {props.restriction && <p>{props.restriction}</p>}
    {!props.canWrite && !props.restriction && <p>Memory changes are unavailable for this caller.</p>}
    {leaveAction && <section role="alert" className="memory-unsaved"><h3>Discard unsaved changes?</h3>
      <p>Your draft has not been saved.</p><div className="n-actions">
        <Button onClick={() => setLeaveAction(undefined)}>Keep editing</Button>
        <Button onClick={() => { const proceed = leaveAction; setLeaveAction(undefined); setMemoryDraft(boardId); proceed() }}>Discard draft</Button>
      </div></section>}
    <MemorySaveStatus save={save} draft={draft} online={props.online} onChangeDraft={(next) => setMemoryDraft(boardId, next)}
      onOpenCard={openCard} onOpenWork={props.onOpenWork} />
    {draft?.kind === 'card' && <MemoryCardEditor boardId={boardId} draft={draft} nodes={nodes} disabled={!canWrite} pending={save.isPending}
      onChange={(next) => setMemoryDraft(boardId, next)} onSave={submit} onCancel={finishEditor} />}
    {draft?.kind === 'note' && <MemoryNoteEditor boardId={boardId} draft={draft} disabled={!canWrite} pending={save.isPending}
      onChange={(next) => setMemoryDraft(boardId, next)} onSave={submit} onCancel={finishEditor} />}
    {props.selectedCardId && <MemoryCardDetail client={client} boardId={boardId} cardId={props.selectedCardId} nodes={nodes}
      health={props.health ?? []} canWrite={Boolean(canWrite)} onBack={() => requestLeave(() => onSelectCard(undefined))}
      onEdit={edit} onOpenWork={props.onOpenWork} onSourcePost={props.onSourcePost} onOpenHistoryWork={props.onOpenHistoryWork} />}
    {!draft && !props.selectedCardId && <>
      <NotesStrip client={client} board={board} canWrite={Boolean(canWrite)} onAdd={() => openDraft(editNoteDraft())}
        onEdit={(note) => openDraft(editNoteDraft(note))} onSourcePost={props.onSourcePost}
        onArchive={(note, archived) => save.mutate({ kind: 'save', command: { kind: 'note_archive', boardId, noteId: note.id, archived, expectedRevision: note.revision } })} />
      <MemoryColumns client={client} board={board} nodes={nodes} filters={props.filters} onFiltersChange={props.onFiltersChange}
        onOpenCard={openCard} onAdd={() => openDraft(newCardDraft())} canWrite={Boolean(canWrite)} />
    </>}
  </div>
}
