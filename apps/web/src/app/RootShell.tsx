import { CollaborationFeatures } from './CollaborationFeatures'
import { UnsavedChangesProvider } from '../shared/ui/UnsavedChangesProvider'
import { AppNavigationHistoryProvider } from '../shared/ui/AppNavigationHistory'
import { Outlet } from '@tanstack/react-router'
import { AppConnectionBoundary } from './AppConnectionBoundary'
import { ReleaseAutoReload } from './RuntimeInstanceBoundary'

import { OperatorChatVisibilityProvider } from '../features/operator-chat'
import { WorkflowOperatorChat, WorkflowOperatorDockProvider } from '../features/workflow-board/WorkflowOperatorDock'
import { ApprovalInbox } from '../features/approvals'
import { useAgentDefaultsQuery } from '../shared/api/query'
import { useAccessFailureLatch } from '../shared/api/useAccessFailureLatch'
import { sessionIsSwitching } from '../shared/api/sessionBoundary'
import { useSyncedTheme } from '../features/theme/useSyncedTheme'

export function RootShell() {
  return <AppConnectionBoundary><AppNavigationHistoryProvider><UnsavedChangesProvider><ReleaseAutoReload /><LocalShell /></UnsavedChangesProvider></AppNavigationHistoryProvider></AppConnectionBoundary>
}

function LocalShell() {
  useSyncedTheme()
  const defaults = useAgentDefaultsQuery()
  // Query retains the last confirmed value during transient refresh failures.
  const denied = useAccessFailureLatch(defaults)
  const enabled = !sessionIsSwitching() && !denied && defaults.data?.value.operator.uiEnabled === true
  const settingsWarning = enabled && (defaults.isError || defaults.failureCount > 0)
    ? 'Settings could not be refreshed. Showing the last confirmed Operator setting for this app.' : undefined
  return <OperatorChatVisibilityProvider enabled={enabled}><WorkflowOperatorDockProvider><CollaborationFeatures><Outlet /></CollaborationFeatures><ApprovalInbox /><WorkflowOperatorChat settingsWarning={settingsWarning} /></WorkflowOperatorDockProvider></OperatorChatVisibilityProvider>
}
