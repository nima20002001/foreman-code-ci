import { parseCoordinationResult,
  parseHierarchyExecutionResult, type HierarchyExecutionResult, type ResultProtocol } from '@foreman-code/contracts'
import { ExecutionResultSchema } from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'

export type HierarchyWorkResult = HierarchyExecutionResult

export function isHierarchyWorkflow(version: WorkflowVersionV3): boolean {
  return version.definition.hierarchy !== undefined
}

/** Saved hierarchy selects work routing; only marked Runs use the coordinated result parser. */
export function parseHierarchyWorkResult(result: unknown, version: WorkflowVersionV3,
  workflowNodeId: string, resultProtocol: ResultProtocol | undefined,
  outstandingRequestIds?: readonly string[]): HierarchyWorkResult {
  if (!version.definition.hierarchy || !version.definition.handoffs) {
    throw new DomainError('HIERARCHY_REQUIRED', 'This saved workflow does not have a hierarchy.', 409)
  }
  const native = ExecutionResultSchema.parse(result)
  if (native.outcome !== 'succeeded') throw new DomainError('HIERARCHY_RESULT_NOT_SUCCESSFUL',
    'A failed or canceled native execution cannot supply a work return.', 409)
  if (!resultProtocol) return parseHierarchyExecutionResult(native.output, version.definition, workflowNodeId, outstandingRequestIds)
  const parsed = parseCoordinationResult(native.output, { resultProtocol,
    definition: version.definition, workflowNodeId,
    ...(outstandingRequestIds ? { outstandingRequestIds } : {}) })
  if (!('routing' in parsed) || !('kind' in parsed.routing)) {
    throw new DomainError('HIERARCHY_RESULT_ROUTING_REQUIRED', 'A hierarchy result requires work routing.', 409)
  }
  return parsed as HierarchyWorkResult
}
