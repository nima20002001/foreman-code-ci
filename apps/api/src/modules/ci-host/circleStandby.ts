import type { CircleAccountRole, CircleSchedulingRole } from '@foreman-code/contracts'
import { withoutCiDatabaseDeadline } from '../../infrastructure/ciDatabasePriority.js'
import type { CircleCreditsReader, CircleCreditsReading } from './circleCredits.js'
import { CircleCreditCache, circleCreditKey, circleMonthStart, type CircleCreditState } from './circleCreditCache.js'

/** The owner is a GitHub organization; circleAccountId chooses its credential-bearing login. */
export interface CircleOrganization {
  owner: string
  circleAccountId: string
  role: CircleAccountRole
  mirrorNames: ReadonlySet<string>
  ready: boolean
}
export interface CircleSchedulingReading extends CircleCreditsReading {
  schedulingRole: CircleSchedulingRole
  schedulingReason: string
  creditProbeAvailable?: boolean
}
export const circleOrgKey = circleCreditKey
const CREDIT_REFUSAL_RETRY_MS = 5 * 60_000

function reason(role: CircleSchedulingRole, probeAvailable: boolean): string {
  if (role === 'exhausted') return probeAvailable
    ? 'CircleCI refused credits. One recovery probe is available; replacement capacity remains active.'
    : 'CircleCI refused credits. Waiting for the five-minute cooldown or the pending recovery probe.'
  if (role === 'standby') return 'Standby capacity waits for CircleCI to refuse a primary organization for credits.'
  return 'Active for new CI jobs.'
}

interface OrganizationStatus {
  org: CircleOrganization
  key: string
  reading: CircleCreditsReading
  policy: NonNullable<CircleCreditState['policy']>
}

function canReplace(status: OrganizationStatus): boolean {
  return !status.policy.exhausted && status.org.ready && status.org.mirrorNames.size > 0
}

/** Assignments belong to exhausted primaries globally; a workspace only filters their mirror support. */
function selectReplacements(statuses: OrganizationStatus[]): Set<string> {
  const ordered = [...statuses].sort((left, right) => left.key.localeCompare(right.key))
  const primaries = ordered.filter(status => status.org.role === 'primary')
  const standbys = ordered.filter(status => status.org.role === 'standby')
  const selected = new Set<string>()
  for (const primary of primaries) {
    const assigned = standbys.find(status => status.key === primary.policy.replacement)
    if (primary.policy.exhausted && assigned && canReplace(assigned) && !selected.has(assigned.key)) {
      selected.add(assigned.key)
    } else delete primary.policy.replacement
  }
  for (const primary of primaries) {
    if (!primary.policy.exhausted || primary.policy.replacement) continue
    const standby = standbys.find(status => !selected.has(status.key) && canReplace(status))
    if (!standby) continue
    primary.policy.replacement = standby.key
    standby.policy.activated = true
    selected.add(standby.key)
  }
  return selected
}

/** Scheduler, start admission and public readback use the same per-org replacement policy. */
export class CircleStandby {
  private readonly pending = new Map<string, Promise<Map<string, CircleSchedulingReading>>>()
  private readonly observed = new Map<string, { month: string; roles: Map<string, CircleSchedulingReading> }>()
  constructor(private readonly organizations: () => Promise<CircleOrganization[]>,
    private readonly credits: CircleCreditsReader, private readonly cache = new CircleCreditCache(),
    private readonly now: () => number = Date.now) {}

  roles(mirrorName?: string): Promise<Map<string, CircleSchedulingReading>> {
    const key = mirrorName ?? ''
    let operation = this.pending.get(key)
    if (!operation) {
      const month = circleMonthStart(this.now())
      operation = withoutCiDatabaseDeadline(() => this.evaluate(mirrorName)).then(roles => {
        this.observed.set(key, { month, roles })
        return roles
      }).finally(() => { this.pending.delete(key) })
      this.pending.set(key, operation)
    }
    return operation
  }

  /** Dispatch observes completed policy; start admission still awaits roles(). */
  snapshot(mirrorName?: string): ReadonlyMap<string, CircleSchedulingReading> | undefined {
    const observed = this.observed.get(mirrorName ?? '')
    return observed?.month === circleMonthStart(this.now()) ? observed.roles : undefined
  }

  async recordCreditRefusal(owner: string, circleAccountId = 'default', runId?: string): Promise<void> {
    const now = this.now()
    await this.cache.transaction(state => {
      const saved = state[circleOrgKey(owner, circleAccountId)] ??= { attempts: [] }
      if (saved.policy?.month !== circleMonthStart(now)) {
        saved.policy = { month: circleMonthStart(now), exhausted: false, activated: false }
      }
      saved.policy.creditRefusedUntil = now + CREDIT_REFUSAL_RETRY_MS
      saved.policy.exhausted = true
      if (saved.policy.creditProbeRunId === runId) delete saved.policy.creditProbeRunId
    })
    this.observed.clear()
  }

  /** The persisted cache lock coordinates all starts and readers for the organization. */
  async admitStart(owner: string, circleAccountId: string, mirrorName: string, runId: string,
    options: { retryUnsent?: true } = {}): Promise<boolean> {
    const reading = await this.reading(owner, circleAccountId, mirrorName)
    const available = reading.schedulingRole === 'active' || reading.creditProbeAvailable === true
    const retryUnsent = options.retryUnsent && (await this.organizations()).some(org =>
      circleOrgKey(org.owner, org.circleAccountId) === circleOrgKey(owner, circleAccountId)
      && org.ready && org.mirrorNames.has(mirrorName))
    if (!available && !retryUnsent) return false
    const admitted = await this.cache.transaction(state => {
      const policy = state[circleOrgKey(owner, circleAccountId)]?.policy
      if (retryUnsent && policy?.creditProbeRunId === runId) return true
      if (!available) return false
      if (policy?.creditRefusedUntil === undefined) return reading.schedulingRole === 'active'
      if (this.now() < policy.creditRefusedUntil || policy.creditProbeRunId) return false
      policy.creditProbeRunId = runId
      return true
    })
    this.observed.clear()
    return admitted
  }

  async recordCreditAcceptance(owner: string, circleAccountId: string, runId: string): Promise<void> {
    await this.cache.transaction(state => {
      const policy = state[circleOrgKey(owner, circleAccountId)]?.policy
      if (policy?.creditProbeRunId !== runId) return
      delete policy.creditRefusedUntil
      delete policy.creditProbeRunId
      policy.exhausted = false
    })
    this.observed.clear()
  }

  async finishCreditProbe(owner: string, circleAccountId: string, runId: string): Promise<void> {
    await this.cache.transaction(state => {
      const policy = state[circleOrgKey(owner, circleAccountId)]?.policy
      if (policy?.creditProbeRunId !== runId) return
      delete policy.creditProbeRunId
      policy.creditRefusedUntil = this.now() + CREDIT_REFUSAL_RETRY_MS
    })
    this.observed.clear()
  }

  private async evaluate(mirrorName?: string): Promise<Map<string, CircleSchedulingReading>> {
    const orgs = await this.organizations()
    const readings = await Promise.all(orgs.map(org => this.credits.reading(org.owner, org.circleAccountId)))
    const month = circleMonthStart(this.now())
    return this.cache.transaction(state => {
      const statuses = orgs.map((org, index) => {
        const key = circleOrgKey(org.owner, org.circleAccountId)
        const saved = state[key] ??= { attempts: [] }
        if (saved.policy?.month !== month) saved.policy = saved.policy?.creditRefusedUntil !== undefined
          ? { ...saved.policy, month } : { month, exhausted: false, activated: false }
        const observed = readings[index]!
        const previousMonth = observed.credits && circleMonthStart(Date.parse(observed.credits.asOf)) !== month
        const reading: CircleCreditsReading = previousMonth
          ? { credits: null, creditsUnavailable: 'Usage from the previous UTC month has expired.' } : observed
        // Old cached exhaustion was inferred from usage; only a provider refusal can block starts.
        saved.policy.exhausted = saved.policy.creditRefusedUntil !== undefined
        return { org, key, reading, policy: saved.policy }
      })
      const selected = selectReplacements(statuses)
      return new Map(statuses.map(status => {
        const supportsMirror = mirrorName ? status.org.mirrorNames.has(mirrorName) : status.org.mirrorNames.size > 0
        const probeAvailable = status.policy.exhausted && status.org.ready && supportsMirror
          && this.now() >= status.policy.creditRefusedUntil! && !status.policy.creditProbeRunId
        let role: CircleSchedulingRole = 'standby'
        if (status.policy.exhausted) role = 'exhausted'
        else if (supportsMirror
          && (status.org.role === 'primary' || selected.has(status.key))) role = 'active'
        return [status.key, { ...status.reading, schedulingRole: role, schedulingReason: reason(role, probeAvailable),
          ...(probeAvailable ? { creditProbeAvailable: true } : {}) }]
      }))
    })
  }

  async eligible(owner: string, circleAccountId = 'default', mirrorName?: string): Promise<boolean> {
    return (await this.roles(mirrorName)).get(circleOrgKey(owner, circleAccountId))?.schedulingRole === 'active'
  }

  async reading(owner: string, circleAccountId = 'default', mirrorName?: string): Promise<CircleSchedulingReading> {
    return (await this.roles(mirrorName)).get(circleOrgKey(owner, circleAccountId)) ?? {
      credits: null, creditsUnavailable: 'This organization is no longer registered.',
      schedulingRole: 'standby', schedulingReason: 'This organization is unavailable for new CI jobs.',
    }
  }
}
