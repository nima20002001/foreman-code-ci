import { create } from 'zustand'
import { raiseFloating } from '../../shared/ui/floatingStack'

interface ApprovalInboxScope {
  workspaceId: string
  workflowId?: string
}

interface ApprovalInboxUiState extends ApprovalInboxScope {
  open: boolean
  openInbox(scope: ApprovalInboxScope): void
  closeInbox(): void
}

export const APPROVAL_INBOX_STACK_ID = 'approval-inbox'

export const useApprovalInboxStore = create<ApprovalInboxUiState>((set) => ({
  open: false,
  workspaceId: '',
  openInbox: (scope) => { raiseFloating(APPROVAL_INBOX_STACK_ID); set({ ...scope, open: true }) },
  closeInbox: () => set({ open: false }),
}))
