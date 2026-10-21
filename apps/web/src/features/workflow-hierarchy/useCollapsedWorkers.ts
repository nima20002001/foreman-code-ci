import { useMemo } from 'react'
import type { WorkflowHierarchy } from '@foreman-code/contracts'
import { useSidePanelPresentation } from '../workflow-board/sidePanelPresentation'

const empty: string[] = []
export function useCollapsedWorkers(scope: string, hierarchy?: WorkflowHierarchy | null) {
  const collapsed = useSidePanelPresentation(state => state.collapsedTeams[scope] ?? empty)
  return useMemo(() => new Set(hierarchy?.parents.filter(member => collapsed.includes(member.parentNodeId))
    .map(member => member.workflowNodeId) ?? []), [hierarchy, collapsed])
}
