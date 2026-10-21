import type { CiHostReply, CiHostRequest, CiHostRun, CiHostStatus } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const FRESHNESS_MS = 5000
/** How long dispatch keeps using the last successful read while a slower refresh of it is still running. */
const REFRESHING_MS = 30_000

/** The device channel was busy with foreground work; the computer itself was not found unready. */
export const isBackgroundYield = (error: unknown) =>
  error instanceof DeviceApplicationAdmissionError && error.reason === 'background_yield'

const TERMINAL = new Set(['passed', 'failed', 'canceled'])

function releaseRun(status: CiHostStatus, run: CiHostRun): CiHostStatus {
  const held = status.runs.find(candidate => candidate.runId === run.runId)
  if (!held || TERMINAL.has(held.state) || held.state === 'lost') return status
  return { ...status, ...status.slotsUsed === undefined ? {} : { slotsUsed: Math.max(0, status.slotsUsed - 1) },
    runs: status.runs.map(candidate => candidate.runId === run.runId ? run : candidate) }
}

interface StatusSnapshot {
  at: number
  status?: CiHostStatus
  pending?: Promise<CiHostReply>
}

/** Planning reuses readiness; slot reservations are still read separately from the database. */
export class CiPlanningSnapshot implements HostCiEndpoint {
  private fleet: { at: number; computers: HostCiComputer[] } | undefined
  private fleetPending: Promise<HostCiComputer[]> | undefined
  private readonly statuses = new Map<string, StatusSnapshot>()
  /** The latest answer per computer, however old; planning sizes from it while a fresh read runs. */
  private readonly lastKnown = new Map<string, { at: number; status: CiHostStatus }>()

  constructor(private readonly endpoint: HostCiEndpoint) {}

  observeComputers(computers: HostCiComputer[]) {
    this.fleet = { at: Date.now(), computers }
    const keys = new Set(computers.map(computer => canonicalJson(computer)))
    for (const key of this.statuses.keys()) {
      if (!keys.has(key)) this.statuses.delete(key)
    }
    for (const key of this.lastKnown.keys()) {
      if (!keys.has(key)) this.lastKnown.delete(key)
    }
  }

  observeStatus(computer: HostCiComputer, reply: CiHostReply) {
    if (reply.operation === 'status') {
      this.statuses.set(canonicalJson(computer), { at: Date.now(), status: reply })
      this.lastKnown.set(canonicalJson(computer), { at: Date.now(), status: reply })
    } else if (reply.run.state === 'lost') {
      // A lost run says the computer itself may be gone; a failed test says nothing about its readiness.
      this.invalidate(computer)
    } else if (TERMINAL.has(reply.run.state)) {
      // A finished run frees its slot now; a held status must not keep it busy until the next read.
      const key = canonicalJson(computer)
      for (const held of [this.statuses.get(key), this.lastKnown.get(key)]) {
        if (held?.status) held.status = releaseRun(held.status, reply.run)
      }
    }
  }

  invalidate(computer: HostCiComputer) {
    this.statuses.delete(canonicalJson(computer))
    this.lastKnown.delete(canonicalJson(computer))
  }

  /** The newest status read for planning, fresh or not. Dispatch still validates readiness itself. */
  lastStatus(computer: HostCiComputer): CiHostStatus | undefined {
    return this.lastKnown.get(canonicalJson(computer))?.status
  }

  /** Dispatch's view: the fresh status, or the last successful one while its refresh is still running. A failed
   * read clears it, so a computer that stops answering is not dispatched to for longer than REFRESHING_MS. */
  dispatchStatus(computer: HostCiComputer): CiHostStatus | undefined {
    const last = this.lastKnown.get(canonicalJson(computer))
    return this.status(computer) ?? (last && Date.now() - last.at < REFRESHING_MS ? last.status : undefined)
  }

  status(computer: HostCiComputer): CiHostStatus | undefined {
    const snapshot = this.statuses.get(canonicalJson(computer))
    return snapshot && Date.now() - snapshot.at < FRESHNESS_MS ? snapshot.status : undefined
  }

  async computers(): Promise<HostCiComputer[]> {
    if (this.fleet && Date.now() - this.fleet.at < FRESHNESS_MS) return this.fleet.computers
    this.fleetPending ??= this.endpoint.computers().then(computers => {
      this.observeComputers(computers)
      return computers
    }).finally(() => { this.fleetPending = undefined })
    return this.fleetPending
  }

  async request(computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> {
    if (request.operation !== 'status') return this.endpoint.request(computer, request)
    const key = canonicalJson(computer)
    let snapshot = this.statuses.get(key)
    if (snapshot?.status && Date.now() - snapshot.at < FRESHNESS_MS) return snapshot.status
    if (snapshot?.pending) return snapshot.pending
    const previous = snapshot
    snapshot = { at: 0 }
    this.statuses.set(key, snapshot)
    const pending = this.endpoint.request(computer, request).then(reply => {
      if (this.statuses.get(key) === snapshot) this.observeStatus(computer, reply)
      return reply
    }).catch(error => {
      if (this.statuses.get(key) === snapshot && previous?.status && isBackgroundYield(error)) {
        // Yielding preserves the answer, but its age still requires a refresh on the next read.
        this.statuses.set(key, { at: previous.at, status: previous.status })
        this.lastKnown.set(key, { at: previous.at, status: previous.status })
        return previous.status
      }
      throw error
    }).finally(() => {
      // A failed or invalid status cannot extend an older readiness snapshot.
      if (this.statuses.get(key) === snapshot) this.statuses.delete(key)
    })
    snapshot.pending = pending
    return pending
  }
}
