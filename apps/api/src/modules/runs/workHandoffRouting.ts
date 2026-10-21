import type { WorkHandoffResult, WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import type { HierarchyWorkResult } from './hierarchyResults.js'
import { repeatConflict } from './repeatResolution.js'

export function selectedWorkHandoffRoutes(definition: WorkflowDefinitionV3, nodeId: string,
  result: WorkHandoffResult | HierarchyWorkResult): string[] {
  const node = definition.nodes.find((item) => item.id === nodeId)
  if (!node) return repeatConflict('WORKFLOW_NODE_NOT_FOUND')
  if (result.routing.kind === 'delegate') return repeatConflict('HIERARCHY_GROUP_ADMISSION_REQUIRED')
  if (result.routing.kind === 'return'
    && (result.routing.outcome !== 'accepted' || result.data.remainingFindings.length)) return []
  if (result.routing.kind === 'return') {
    if (node.choice) return []
    return definition.edges.filter(edge => edge.kind === 'execution' && edge.source === nodeId
      && definition.nodes.some(target => target.id === edge.target && target.join?.mode === 'all'))
      .map(edge => edge.id)
  }
  const outcome = result.routing.outcome
  if (outcome === undefined) {
    if (node.choice || result.data.remainingFindings.length) return []
    return definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === nodeId)
      .map((edge) => edge.id)
  }
  const declared = node.choice?.outcomes.find((item) => item.outcome === outcome)
  if (!declared || result.routing.kind === 'request' && declared.target.kind !== 'edge') {
    return repeatConflict('WORK_REQUEST_OUTCOME_UNDECLARED')
  }
  return declared.target.kind === 'edge' ? [declared.target.relationshipId] : []
}
