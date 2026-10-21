import { errorMessage } from '../errorMessage'
import type { HarnessMcpManagedInput, HarnessMcpPlan } from '@foreman-code/contracts/management'

export type ManagedMcpOperation = {
  input: HarnessMcpManagedInput
  phase: 'sending' | 'retry' | 'review'
  uncertainDelivery: boolean
  plan?: HarnessMcpPlan
  error?: string
}
export function terminalMcpPlan(plan: HarnessMcpPlan): boolean {
  return ['applied', 'rejected', 'failed', 'reconciled'].includes(plan.status)
}
export function reserveManagedMcpOperation(input: HarnessMcpManagedInput): ManagedMcpOperation {
  return { input: structuredClone(input), phase: 'sending', uncertainDelivery: false }
}
export function managedMcpSucceeded(operation: ManagedMcpOperation, plan: HarnessMcpPlan): ManagedMcpOperation | null {
  if (terminalMcpPlan(plan)) return null
  return { ...operation, plan, phase: plan.status === 'pending' ? 'retry' : 'review',
    error: plan.error ?? '' }
}
function definitePrePlanRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  if (error.code === 'INVALID_REQUEST') return true
  return 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.status !== 429 && error.code !== 'HTTP_ERROR' && error.code !== 'INVALID_RESPONSE'
}
export function managedMcpFailed(operation: ManagedMcpOperation, error: unknown): ManagedMcpOperation | null {
  // An error after acceptance, or after any lost response, cannot erase the
  // command's identity. A later 4xx does not disprove an earlier commit.
  if (!operation.plan && !operation.uncertainDelivery && definitePrePlanRejection(error)) return null
  return { ...operation, phase: 'retry', uncertainDelivery: true,
    error: errorMessage(error, 'The change could not be confirmed. Retry its original command.') }
}
