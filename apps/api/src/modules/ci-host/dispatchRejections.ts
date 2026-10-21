import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { CiHostStatus, CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer } from './serviceTypes.js'

function executorKey(computer: HostCiComputer): string {
  const hostRef = { ...computer.hostRef }
  // Cloud slots share provider login and capacity.
  if (hostRef.kind === 'cloud') delete hostRef.slot
  return canonicalJson(hostRef)
}

function executorState(computer: HostCiComputer, status: CiHostStatus | undefined): string {
  return canonicalJson({
    buildAllowancePercent: status?.buildAllowancePercent ?? computer.buildAllowancePercent,
    userSystemd: status?.userSystemd ?? computer.userSystemd,
    cpuCount: status?.cpuCount,
    memoryBytes: status?.memoryBytes,
    ready: status?.ready,
    reasons: status?.reasons,
    slotsTotal: status?.slotsTotal,
    slotsUsed: status?.slotsUsed,
    availableMemoryBytes: status?.availableMemoryBytes,
    startProtocolVersion: status?.startProtocolVersion,
    running: status?.runs.map(run => ({ runId: run.runId, state: run.state }))
      .sort((left, right) => left.runId.localeCompare(right.runId)),
  })
}

const TRANSIENT_BACKOFF_MS = 60_000

/** Unchanged status preserves structural refusals; transient refusals expire after backoff. */
export class CiDispatchRejections {
  private readonly tickets = new Map<string, Map<string, { state: string; message: string; expiresAt: number }>>()

  retain(queued: readonly CiRunRecord[]) {
    const ids = new Set(queued.map(run => run.id))
    for (const id of this.tickets.keys()) {
      if (!ids.has(id)) this.tickets.delete(id)
    }
  }

  record(ticketId: string, computer: HostCiComputer, status: CiHostStatus | undefined, message: string,
    options: { structural?: boolean } = {}) {
    let rejected = this.tickets.get(ticketId)
    if (!rejected) {
      rejected = new Map()
      this.tickets.set(ticketId, rejected)
    }
    rejected.set(executorKey(computer), { state: executorState(computer, status), message,
      expiresAt: options.structural ? Infinity : Date.now() + TRANSIENT_BACKOFF_MS })
  }

  reason(ticketId: string, computer: HostCiComputer, status: CiHostStatus | undefined): string | undefined {
    const rejected = this.tickets.get(ticketId)
    if (!rejected) return undefined
    const key = executorKey(computer)
    const previous = rejected.get(key)
    if (!previous) return undefined
    // An invalidated or in-flight status is not an observed state change.
    if (Date.now() < previous.expiresAt
      && (!status || previous.state === executorState(computer, status))) return previous.message
    rejected.delete(key)
    return undefined
  }
}
