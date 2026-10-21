import { parseCoordinationResult, type CoordinationResult, type CoordinationResultContext,
  type ExecutionResult, type HarnessExecutionContext, type ResultProtocol } from '@foreman-code/contracts'
import { canonicalGraphJson, parseWorkHandoffArtifactResult, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { parseWorkflowArtifactResult, type WorkflowArtifactResultV1 } from '@foreman-code/contracts/workflow-artifact-result'
import { parseWorkResultForInput, receivedWorkRequestIds, resolveWorkResultForInput } from './workHandoffResult.js'
import { parseHierarchyWorkResult, type HierarchyWorkResult } from './hierarchyResults.js'

/** The immutable Run marker is the only selector. Parsing never replaces the
 * original native result or strips the bytes used for accepted evidence. */
export function parseWorkflowCoordinationResult(result: ExecutionResult, context: CoordinationResultContext,
  input?: unknown, executionContext?: HarnessExecutionContext): CoordinationResult {
  if (result.outcome !== 'succeeded') throw new Error('COORDINATION_RESULT_NOT_SUCCESSFUL')
  // The accepted native carrier remains byte-for-byte unchanged. Its existing
  // result-receipt bound therefore applies before effects or acceptance too.
  canonicalGraphJson(result, 64 * 1024)
  const parsed = parseCoordinationResult(result.output, { ...context,
    ...(executionContext?.outstandingRequestIds ? { outstandingRequestIds: executionContext.outstandingRequestIds } : {}) })
  if (context.interval || !context.definition.handoffs) return parsed
  if (!('routing' in parsed) || !('kind' in parsed.routing)) throw new Error('HANDOFF_RESULT_ROUTING_REQUIRED')
  const handoff = resolveWorkResultForInput(parsed as Extract<CoordinationResult, { routing: { kind: string } }>, input, executionContext)
  if (context.definition.hierarchy && handoff.routing.kind === 'finish'
    && input !== undefined && receivedWorkRequestIds(input, executionContext).length) throw new Error('HIERARCHY_RETURN_REQUIRED')
  return handoff
}

export function parseWorkflowWorkResult(result: ExecutionResult, version: WorkflowVersionV3,
  workflowNodeId: string, resultProtocol?: ResultProtocol, input?: unknown, executionContext?: HarnessExecutionContext) {
  if (!resultProtocol && version.definition.hierarchy) {
    const parsed = parseHierarchyWorkResult(result, version, workflowNodeId, undefined, executionContext?.outstandingRequestIds)
    if (parsed.routing.kind === 'finish' && input !== undefined && receivedWorkRequestIds(input, executionContext).length) throw new Error('HIERARCHY_RETURN_REQUIRED')
    return resolveWorkResultForInput(parsed, input, executionContext)
  }
  if (!resultProtocol) return parseWorkResultForInput(result, input, executionContext)
  const parsed = parseWorkflowCoordinationResult(result, { resultProtocol, definition: version.definition,
    workflowNodeId }, input, executionContext)
  if (!('routing' in parsed) || !('kind' in parsed.routing)) throw new Error('HANDOFF_RESULT_ROUTING_REQUIRED')
  return parsed as HierarchyWorkResult
}

/** Artifact mappings still come from this exact native result. The coordinated
 * envelope adds summary/board without creating a second artifact authority. */
export function workflowArtifactResult(result: ExecutionResult, version: WorkflowVersionV3,
  workflowNodeId: string, resultProtocol?: ResultProtocol): WorkflowArtifactResultV1 {
  const node = version.definition.nodes.find(item => item.id === workflowNodeId)
  if (!node || node.kind === 'job' || !node.artifactOutputs) throw new Error('WORKFLOW_ARTIFACT_OUTPUTS_UNDECLARED')
  if (resultProtocol) {
    if (result.outcome !== 'succeeded') throw new Error('COORDINATION_RESULT_NOT_SUCCESSFUL')
    const parsed = parseCoordinationResult(result.output, { resultProtocol, definition: version.definition, workflowNodeId })
    if (!('artifactOutputs' in parsed) || !parsed.artifactOutputs) throw new Error('WORKFLOW_ARTIFACT_OUTPUTS_REQUIRED')
    return parsed.artifactOutputs
  }
  if (version.definition.hierarchy) {
    const parsed = parseHierarchyWorkResult(result, version, workflowNodeId, resultProtocol)
    if (!parsed.artifactOutputs) throw new Error('WORKFLOW_ARTIFACT_OUTPUTS_REQUIRED')
    return parsed.artifactOutputs
  }
  if (version.definition.handoffs) return parseWorkHandoffArtifactResult(result, node.artifactOutputs).artifactOutputs
  return node.choice ? parseWorkflowArtifactResult(result, node.artifactOutputs, node.choice).artifactOutputs
    : parseWorkflowArtifactResult(result, node.artifactOutputs).artifactOutputs
}
