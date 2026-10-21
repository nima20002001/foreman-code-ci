import { errorMessage } from '../errorMessage'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { staysOnWorkflowBoard } from '@foreman-code/contracts/wave25'
import { Alert, Button, Dialog } from './nocturne'
import { UnsavedChangesContext, type EditorRegistration, type LeaveTarget } from './unsavedChanges'

interface Request { ids: string[]; resolve(leave: boolean): void }

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const editors = useRef(new Map<string, EditorRegistration>())
  const pending = useRef<Request | null>(null)
  const working = useRef(false)
  const [request, setRequest] = useState<Request | null>(null)
  const [phase, setPhase] = useState<'idle' | 'working' | 'settled'>('idle')
  const [failure, setFailure] = useState<string>()
  const [revision, refresh] = useState(0)
  const activeEditors = useCallback((ids: string[]) => ids.flatMap((id) => {
    const editor = editors.current.get(id)?.current
    return editor && (editor.dirty || editor.busy || editor.uncertain) ? [{ id, editor }] : []
  }), [])
  const finish = useCallback((leave: boolean) => {
    const current = pending.current
    pending.current = null
    setRequest(null)
    setPhase('idle')
    setFailure(undefined)
    current?.resolve(leave)
  }, [])
  const ask = useCallback((ids = [...editors.current.keys()]) => {
    // A second navigation must not replace the destination already under review.
    if (pending.current) return Promise.resolve(false)
    if (!activeEditors(ids).length) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const next = { ids, resolve }
      pending.current = next
      setFailure(undefined)
      setRequest(next)
    })
  }, [activeEditors])
  const register = useCallback((id: string, editor: EditorRegistration) => {
    editors.current.set(id, editor)
    return () => { editors.current.delete(id) }
  }, [])
  const surfaces = useCallback(() => ask([...editors.current].filter(([, entry]) => entry.current.scope === 'surface').map(([id]) => id)), [ask])
  const changed = useCallback(() => refresh((value) => value + 1), [])
  const unsaved = useCallback(() => activeEditors([...editors.current.keys()]).length > 0, [activeEditors])
  const context = useMemo(() => ({ register, request: ask, changed, surfaces, unsaved }), [register, ask, changed, surfaces, unsaved])
  const shouldBlockFn = useCallback(async ({ current, next }: { current: LeaveTarget; next: LeaveTarget }) => {
    if (current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search)) return false
    if (pending.current) return true
    const sameBoard = staysOnWorkflowBoard(current, next)
    // The Board editor survives Run selection, but toolbar forms can unmount.
    const ids = [...editors.current].filter(([, editor]) =>
      (!sameBoard || editor.current.scope === 'surface')
      && (!editor.blocks || editor.blocks(current, next))
      && !editor.current.canResume?.()).map(([id]) => id)
    return !await ask(ids)
  }, [ask])
  const enableBeforeUnload = useCallback(() => activeEditors([...editors.current.keys()]).some(({ editor }) => !editor.canResume?.()), [activeEditors])
  useBlocker({ shouldBlockFn, enableBeforeUnload })
  useEffect(() => () => { pending.current?.resolve(false) }, [])
  // Read after the save/discard React commit, so newer edits cannot be mistaken for a clean draft.
  useEffect(() => {
    if (!request || working.current) return
    if (!activeEditors(request.ids).length && !failure) finish(true)
    else if (phase === 'settled') setPhase('idle')
  }, [phase, request, activeEditors, finish, revision, failure])
  const remaining = request ? activeEditors(request.ids) : []
  const active = remaining.at(-1)?.editor
  const busy = phase === 'working' || Boolean(active?.busy)
  const act = async (choice: 'save' | 'discard') => {
    if (working.current || busy) return
    if (!active) { finish(true); return }
    working.current = true
    setPhase('working')
    setFailure(undefined)
    try { await active[choice]() }
    catch (error) { setFailure(errorMessage(error, 'Changes could not be saved. Your draft is kept.')) }
    finally { working.current = false; setPhase('settled') }
  }
  return <UnsavedChangesContext.Provider value={context}>{children}
    <Dialog open={Boolean(request)} title="Save changes before leaving?" role="alertdialog" size="sm" busy={busy}
      description={active ? `You have unsaved changes in ${active.label}.` : 'Your changes have been resolved.'}
      onOpenChange={(open) => { if (!open && !working.current) finish(false) }}
      footer={<>
        <Button disabled={busy || active?.uncertain} onClick={() => void act('discard')}>Discard</Button>
        <Button variant="primary" disabled={busy || active?.saveDisabled} onClick={() => void act('save')}>
          {busy ? 'Saving…' : active?.uncertain ? 'Retry original save' : active ? 'Save' : 'Continue'}
        </Button>
      </>}>
      {active?.uncertain ? <Alert tone="warning" title="The previous save is unconfirmed. Retry it before leaving or discarding." /> : null}
      {failure || active?.error ? <Alert live tone="danger" title={failure ?? active?.error ?? ''} /> : null}
      {remaining.length > 1 ? <p>Other edited forms will be reviewed next.</p> : null}
    </Dialog>
  </UnsavedChangesContext.Provider>
}
