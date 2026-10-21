import type { ExecutionResult, HarnessExecutionContext } from '@foreman-code/contracts'
import { ZodError } from 'zod'
import { parseWorkResultForInput, receivedWorkRequestIds } from '../runs/workHandoffResult.js'

export function workResultRepairPrompt(result: ExecutionResult, contract: string, input?: unknown,
  context?: HarnessExecutionContext): string | undefined {
  if (result.outcome !== 'succeeded') return undefined
  try {
    parseWorkResultForInput(result, input, context)
    return undefined
  } catch (error) {
    const issues = error instanceof ZodError ? JSON.stringify(error.issues) : String(error)
    return [
      'Your complete result failed the pinned work-handoff contract.',
      `Validation issues: ${issues}`,
      ...(input === undefined ? [] : [`Valid open request IDs: ${JSON.stringify(receivedWorkRequestIds(input, context))}`]),
      'Correct the result format and return the complete JSON object again. Preserve your deliverable and findings.',
      'This is a corrective turn in the same execution. Do not repeat the task or perform additional work.',
      'Expected result shape and saved routing constraints:',
      contract,
    ].join('\n')
  }
}
