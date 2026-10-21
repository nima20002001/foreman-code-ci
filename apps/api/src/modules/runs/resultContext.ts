import type { CoordinationResultContext, ResultProtocol } from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { repeatTickIndex } from './repeatResolution.js'

export function workflowResultContext(version: WorkflowVersionV3, execution: {
  workflowNodeId: string; resultProtocol?: ResultProtocol | undefined; input?: unknown
}): CoordinationResultContext | undefined {
  if (!execution.resultProtocol) return undefined
  return { resultProtocol: execution.resultProtocol, definition: version.definition,
    workflowNodeId: execution.workflowNodeId, interval: repeatTickIndex(execution.input) !== undefined }
}
