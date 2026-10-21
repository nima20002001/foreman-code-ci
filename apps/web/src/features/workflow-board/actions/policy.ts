import type { RunExecutionsPage } from '@foreman-code/contracts/wave25'
export type ActionRun = RunExecutionsPage['run']

export function needsRunRefresh(run: ActionRun): boolean {
  return run.executionState !== 'completed' || run.cleanupPending
}
export function newFullRunReason(run: ActionRun): string | undefined {
  if (run.executionState !== 'completed') return 'This Run is still active. A full retry is available only after failure or cancellation and cleanup.'
  if (run.cleanupPending) return 'Cleanup is pending. A new full Run is unavailable until the server confirms cleanup has finished.'
  if (run.outcome !== 'failed' && run.outcome !== 'canceled') return 'A full retry is offered only for failed or canceled Runs.'
  return undefined
}
export function approvalDeliveryMessage(status: string, deliveryState: string): string {
  if (status === 'delivered' && deliveryState === 'delivered') return 'Native delivery is recorded. This does not prove execution completion or cleanup settlement.'
  if (status === 'delivery_failed') return 'Approval delivery failed. The decision is not permission to send a replacement native response.'
  if (status === 'canceled' && deliveryState === 'uncertain') return 'This interaction is canceled, but whether an earlier response reached the provider is unknown. It will not be resent.'
  if (deliveryState === 'uncertain') return 'Native delivery is uncertain. Recovery is backend-owned; a client refresh is not provider restart recovery.'
  if (status === 'canceled') return 'This interaction is canceled. No approval response is available.'
  if (status === 'pending') return 'A human decision is pending. No native acknowledgement is recorded.'
  return 'The decision is recorded; native acknowledgement is not yet confirmed.'
}
