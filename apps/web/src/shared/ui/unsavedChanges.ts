import { createContext, useContext, useId, useLayoutEffect, useRef } from 'react'

export interface UnsavedEditor {
  scope?: 'surface'
  label: string
  dirty: boolean
  busy?: boolean
  uncertain?: boolean
  /** True only when this editor can be recovered after navigation or reload. */
  canResume?(): boolean
  saveDisabled?: boolean
  error?: string
  save(): unknown | Promise<unknown>
  discard(): unknown | Promise<unknown>
}
export interface LeaveTarget { pathname: string; search: Record<string, unknown> }
export interface EditorRegistration {
  current: UnsavedEditor
  blocks?(current: LeaveTarget, next: LeaveTarget): boolean
}
export const UnsavedChangesContext = createContext<{
  surfaces(): Promise<boolean>
  changed(): void
  register(id: string, editor: EditorRegistration): () => void
  request(ids?: string[]): Promise<boolean>
  /** True while any editor holds unsaved, busy, or unconfirmed changes; never prompts. */
  unsaved?(): boolean
} | null>(null)

/** Register the existing draft, never copy it into the navigation guard. */
export function useUnsavedChanges(editor: UnsavedEditor, blocks?: EditorRegistration['blocks']) {
  const context = useContext(UnsavedChangesContext)
  const id = useId()
  const ref = useRef<EditorRegistration>({ current: editor, blocks })
  useLayoutEffect(() => { ref.current.current = editor; ref.current.blocks = blocks })
  useLayoutEffect(() => { context?.changed() }, [context, editor.dirty, editor.busy, editor.uncertain, editor.error, editor.saveDisabled])
  useLayoutEffect(() => context?.register(id, ref.current), [context, id])
  return async (action: () => void) => {
    if (!context || await context.request([id])) action()
  }
}

export function UnsavedEditorGuard({ editor }: { editor: UnsavedEditor }) {
  useUnsavedChanges(editor)
  return null
}
