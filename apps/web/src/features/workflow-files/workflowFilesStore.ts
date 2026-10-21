import { createStore } from 'zustand/vanilla'
import type { FileWithRevision } from '@foreman-code/contracts/files'
import type { SelectionIssue } from '../attachments/attachmentFiles'

interface RemovalSelection { row: FileWithRevision; commandId: string }
interface WorkflowFilesPresentation {
  open: boolean
  removal: RemovalSelection | null
  selectionIssue: SelectionIssue | null
  setOpen(open: boolean): void
  setRemoval(removal: RemovalSelection | null): void
  setSelectionIssue(issue: SelectionIssue | null): void
}

/** Ephemeral per-mounted-board interaction state, never a server-state cache. */
export function createWorkflowFilesStore() {
  return createStore<WorkflowFilesPresentation>((set) => ({
    open: false, removal: null, selectionIssue: null,
    setOpen: (open) => set({ open }),
    setRemoval: (removal) => set({ removal }),
    setSelectionIssue: (selectionIssue) => set({ selectionIssue }),
  }))
}
