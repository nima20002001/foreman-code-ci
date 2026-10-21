import { errorMessage } from '../../shared/errorMessage'
import type { JobLogPage } from '@foreman-code/contracts/jobs'
import type { JobDefinitionSpecRecord, JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { ApiError } from '../../shared/api/client'

export const jobAccessLost = (error: unknown) => ApiError.is(error) && [401, 403, 404].includes(error.status)
/** A response for another job/Run is a contradiction, not a transient fault: never retry it. */
export const jobReadRetry = (count: number, error: unknown) => !jobAccessLost(error) && !(ApiError.is(error) && error.code === 'JOB_SELECTION_MISMATCH') && count < 1
export function jobError(error: unknown) {
  if (jobAccessLost(error)) return 'Job history unavailable or permission lost. Previously loaded data is hidden.'
  return errorMessage(error, 'The job request could not be completed.')
}
/** Strip CSI, OSC, escape and nonprinting controls. React renders the remaining output as text. */
export function plainLog(text: string) {
  // Control matching is intentional: remove terminal commands before display.
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
export function loadedChunks(pages: JobLogPage[] = []) {
  const chunks = new Map<string, JobLogPage['chunks'][number]>()
  for (const page of pages) for (const chunk of page.chunks) chunks.set(`${chunk.attemptId}:${chunk.sequence}`, chunk)
  return [...chunks.values()].sort((a, b) => a.sequence - b.sequence)
}
export function processLabel(execution: JobExecutionRecord) {
  const { process } = execution
  if (process.outcome === 'cancelled' && process.processStopped) return 'Cancellation confirmed'
  if (execution.cancelRequestedAt && !process.processStopped) return 'Cancellation requested · stop unconfirmed'
  return (process.outcome ?? process.phase).replaceAll('_', ' ')
}
export function jobNetworkLabel(network: JobDefinitionSpecRecord['policy']['network']) {
  return typeof network === 'string' ? network : network.mode
}
export function queueLabel(ticket: JobQueueTicket) {
  if (ticket.state === 'terminal') return (ticket.terminalReason ?? 'terminal').replaceAll('_', ' ')
  if (ticket.cancelRequestedAt) return 'Cancellation requested · stop unconfirmed'
  if (ticket.sourceCapacityWait) return 'Waiting for source capacity'
  const labels = { waiting: 'Queued · waiting', blocked: 'Queued · blocked',
    claimed: 'Claimed · preparing', accepted: 'Accepted' }
  return labels[ticket.state]
}
