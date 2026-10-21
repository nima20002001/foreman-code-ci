import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { CoordinationResultContext, ExecutionResult, HarnessExecutionContext } from '@foreman-code/contracts'
import { ZodError } from 'zod'
import { parseWorkResultForInput, receivedWorkRequestIds } from '../runs/workHandoffResult.js'
import { parseWorkflowCoordinationResult, parseWorkflowWorkResult } from '../runs/workflowCoordinationResult.js'

export function workResultRepairPrompt(result: ExecutionResult, contract: string, input?: unknown,
  context?: HarnessExecutionContext, coordination?: CoordinationResultContext,
  hierarchy?: { version: WorkflowVersionV3; workflowNodeId: string }): string | undefined {
  if (result.outcome !== 'succeeded') return undefined
  try {
    if (coordination) parseWorkflowCoordinationResult(result, coordination, input, context)
    else if (hierarchy) parseWorkflowWorkResult(result, hierarchy.version, hierarchy.workflowNodeId, undefined, input, context)
    else parseWorkResultForInput(result, input, context)
    return undefined
  } catch (error) {
    const issues = error instanceof ZodError ? JSON.stringify(error.issues) : String(error)
    return [
      coordination ? 'Your complete result failed the pinned coordinated result contract.'
        : 'Your complete result failed the pinned work-handoff contract.',
      `Validation issues: ${issues}`,
      ...(input === undefined || coordination && (!coordination.definition.handoffs || coordination.interval)
        ? [] : [`Valid open request IDs: ${JSON.stringify(receivedWorkRequestIds(input, context))}`]),
      'Correct the result format and return the complete JSON object again. Preserve your deliverable and findings.',
      'This is a corrective turn in the same execution. Do not repeat the task or perform additional work.',
      'Expected result shape and saved routing constraints:',
      contract,
    ].join('\n')
  }
}
