import type { WorkflowHierarchy } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne'
import { useSidePanelPresentation } from '../workflow-board/sidePanelPresentation'
import './hierarchy.css'

const empty: string[] = []

/** Local display controls never change saved membership, routes or geometry. */
export function HierarchyCanvasControls({ scope, hierarchy, name, onTeam }: {
  scope: string; hierarchy?: WorkflowHierarchy | null; name(nodeId: string): string; onTeam?(nodeId: string): void
}) {
  const collapsed = useSidePanelPresentation(state => state.collapsedTeams[scope] ?? empty)
  const teams = hierarchy?.parents.filter(member => member.parentNodeId === hierarchy.masterNodeId) ?? []
  if (!teams.length) return null
  return <nav className="hierarchy-canvas-controls" aria-label="Team visibility">{teams.map(team => {
    const workers = hierarchy!.parents.filter(member => member.parentNodeId === team.workflowNodeId).length
    const hidden = collapsed.includes(team.workflowNodeId)
    return <span key={team.workflowNodeId}><strong>{name(team.workflowNodeId)}</strong>
      {workers ? <Button size="sm" aria-expanded={!hidden} aria-label={`${hidden ? 'Show' : 'Hide'} Workers for ${name(team.workflowNodeId)}`}
        onClick={() => useSidePanelPresentation.getState().toggleTeam(scope, team.workflowNodeId)}>{hidden ? 'Show' : 'Hide'} Workers · {workers}</Button> : null}
      {onTeam ? <Button size="sm" onClick={() => onTeam(team.workflowNodeId)}>View team</Button> : null}</span>
  })}</nav>
}
