import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { Button, IconButton } from '../../shared/ui/nocturne/Button'
import { Icon } from '../../shared/ui/nocturne/Icon'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { RunsWindow } from './RunsWindow'
import { labelRuns, RUNS_MAX_PAGES } from './presentation'
import { isRunAccessError, runReadErrorLabel, useRunSummaries, useSelectedRunSnapshot } from './query'
import { useRunsSelectorUi } from './uiStore'
import type { SelectedRunState } from './useSelectedRun'
import './runsSelector.css'

export type RunsSelectorProps = { selection: SelectedRunState; className?: string }

/** Mount beside Board controls; selection can be shared with the snapshot/chat consumer. */
export function RunsSelector({ selection, className = '' }: RunsSelectorProps) {
  const id = useId()
  const { identity } = selection
  const openId = JSON.stringify([id, identity.workspaceId, identity.workflowId])
  const open = useRunsSelectorUi((state) => state.openId === openId)
  const trigger = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const initialFocus = useRef<'first' | 'last'>('first')
  const typeahead = useRef({ text: '', at: 0 })
  const history = useRunSummaries(identity, open && selection.active)
  const selected = useSelectedRunSnapshot(selection)
  const rows = labelRuns(history.items)
  const denied = isRunAccessError(history.error)
  const capped = (history.data?.pages.length ?? 0) >= RUNS_MAX_PAGES
    && history.data?.pages.at(-1)?.pageInfo.nextCursor !== null
  const brokenCursor = !capped && !history.hasNextPage && history.data?.pages.at(-1)?.pageInfo.nextCursor != null
  const selectedMessage = selection.invalid ? 'Invalid Run' : identity.runId === null ? null
    : selected.isError ? runReadErrorLabel(selected.error) : selected.isPending ? 'Loading…' : null

  const geometryScope = JSON.stringify([sessionGeneration(), identity.workspaceId, identity.workflowId])
  function buttons() {
    return Array.from(surface.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not([disabled])') ?? [])
  }
  function close(restoreFocus = false) {
    if (useRunsSelectorUi.getState().openId === openId) useRunsSelectorUi.getState().setOpen(null)
    if (restoreFocus) trigger.current?.focus()
  }
  function show(last = false) {
    initialFocus.current = last ? 'last' : 'first'
    typeahead.current = { text: '', at: 0 }
    useRunsSelectorUi.getState().setOpen(openId)
  }
  function choose(runId: string | null) {
    close(true)
    void selection.selectRun(runId)
  }

  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    if (active && active !== document.body && active !== trigger.current && active !== surface.current) return
    const items = Array.from(surface.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not([disabled])') ?? [])
    ;((initialFocus.current === 'last' ? items.at(-1) : items[0]) ?? surface.current)?.focus()
  }, [open, openId, rows.length])
  useEffect(() => () => {
    // History navigation, scope changes, and unmount close only this window.
    if (useRunsSelectorUi.getState().openId === openId) useRunsSelectorUi.getState().setOpen(null)
  }, [openId, selection.generation.id])

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    const items = buttons()
    if (items.length === 0) return
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    let next = -1
    if (event.key === 'ArrowDown') next = (index + 1) % items.length
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = items.length - 1
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const at = Date.now(), character = event.key.toLocaleLowerCase()
      const previous = at - typeahead.current.at < 700 ? typeahead.current.text : ''
      const text = previous === character ? character : previous + character
      typeahead.current = { text, at }
      for (let offset = 1; offset <= items.length; offset++) {
        const candidate = (index + offset) % items.length
        const label = items[candidate]!.getAttribute('aria-label') ?? items[candidate]!.textContent ?? ''
        if (label.toLocaleLowerCase().startsWith(text)) { next = candidate; break }
      }
    }
    if (next >= 0) { event.preventDefault(); items[next]?.focus() }
  }

  return <div className={`n-menu runs-selector ${className}`}>
    <Button ref={trigger} size="sm" variant="ghost" className="runs-selector-trigger" aria-label="Runs" title="Runs"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={!selection.active}
      onClick={() => open ? close() : show()} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp') }
      }}>
      Runs <Icon name="down" size={13} />
    </Button>
    {identity.runId !== null || selection.invalid ? <IconButton label="Return to workflow" size="sm" variant="ghost"
      disabled={!selection.active} onClick={() => choose(null)}><Icon name="arrow" size={14} style={{ transform: 'rotate(180deg)' }} /></IconButton> : null}
    {selectedMessage && <span role="status" className="runs-selector-selection-status">{selectedMessage}</span>}
    {open && <RunsWindow id={id} scope={geometryScope} anchor={trigger} close={() => close(true)}>
      <div ref={surface} role="menu" tabIndex={-1} aria-label="Runs" className="n-menu-list runs-selector-menu"
      aria-busy={history.isPending || history.isFetchingNextPage} onKeyDown={keyboard}>
      {rows.length > 0 && <div className="runs-selector-head" aria-hidden="true">
        <span /><span>Status</span><span>Started</span><span>Trigger</span><span>Run</span>
      </div>}
      <button type="button" role="menuitemradio" aria-label="New run"
        aria-checked={identity.runId === null && !selection.invalid} tabIndex={-1}
        className="runs-selector-option" onClick={() => choose(null)}>
        <span className="runs-selector-mark" aria-hidden="true">{identity.runId === null && !selection.invalid ? '✓' : ''}</span>
        <span style={{ gridColumn: '2 / -1' }}>New run</span>
      </button>
      {rows.map(({ run, time, status, label }) => <button key={run.runId} type="button" role="menuitemradio"
        aria-label={label} aria-checked={identity.runId === run.runId} tabIndex={-1} className="runs-selector-option"
        data-run-id={run.runId} data-status={run.status} onClick={() => choose(run.runId)}>
        <span className="runs-selector-mark" aria-hidden="true">{identity.runId === run.runId ? '✓' : ''}</span>
        <span className="runs-selector-status"><span className="runs-selector-dot" aria-hidden="true" />{status}</span>
        <span className="runs-selector-time">{time}</span>
        <span className="runs-selector-trigger-cell">{run.trigger === 'schedule' ? 'Scheduled' : 'Manual'}</span>
        <code title={run.runId}>{run.shortId}</code>
      </button>)}
      {history.isPending && <p role="status" className="runs-selector-state">Loading…</p>}
      {history.isError && <p role="status" className="runs-selector-state">{runReadErrorLabel(history.error, 'list')}</p>}
      {history.isSuccess && rows.length === 0 && <p role="status" className="runs-selector-state">No runs</p>}
      {!denied && selected.snapshot && identity.runId !== null && !rows.some(({ run }) => run.runId === identity.runId)
        && <p role="status" className="runs-selector-state">Selected Run outside page</p>}
      {history.isError && !history.isFetchNextPageError && !denied && <button type="button" role="menuitem" tabIndex={-1}
        aria-disabled={history.isFetching} onClick={() => { if (!history.isFetching) void history.refetch() }}>Retry</button>}
      {!denied && (history.hasNextPage || (history.data?.pages.length ?? 0) > 1 || brokenCursor) && <button
        type="button" role="menuitem" tabIndex={-1} className="runs-selector-more"
        aria-disabled={!history.hasNextPage || history.isFetching}
        onClick={() => { if (history.hasNextPage && !history.isFetching) void history.fetchNextPage({ cancelRefetch: false }) }}>
        {history.isFetchingNextPage ? 'Loading…' : capped ? 'Limit reached' : brokenCursor ? 'More unavailable'
          : history.isFetchNextPageError ? 'Retry more' : history.hasNextPage ? 'More' : 'No more'}
      </button>}
      </div>
    </RunsWindow>}
  </div>
}
