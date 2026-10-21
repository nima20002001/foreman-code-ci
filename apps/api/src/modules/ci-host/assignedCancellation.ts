import type { CiRunRecord } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { CiRunSettlement, HostCiComputer, HostCiEndpoint } from './serviceTypes.js'
import { ciExecutionRunId } from './executionAttempt.js'

function canceledBeforeExecution(run: CiRunRecord, computer: HostCiComputer): CiRunSettlement {
  const now = new Date().toISOString()
  return { runId: run.id, state: 'canceled', step: null, exitCode: null,
    startedAt: computer.hostRef.kind === 'cloud' ? null : now,
    finishedAt: now, message: 'Canceled before execution.', logBytes: 0 }
}

export async function cancelAssignedCiTicket(endpoint: HostCiEndpoint, computer: HostCiComputer,
  run: CiRunRecord): Promise<CiRunSettlement> {
  try {
    const reply = await endpoint.request(computer, { operation: 'cancel', runId: ciExecutionRunId(run) })
    if (reply.operation !== 'cancel') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    }
    return reply.run
  } catch (error) {
    // Cloud starts persist ownership before dispatch; no journal means no workflow was sent.
    if (computer.hostRef.kind === 'cloud' && run.state === 'starting' && !run.startedAt
      && error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN') return canceledBeforeExecution(run, computer)
    throw error
  }
}
