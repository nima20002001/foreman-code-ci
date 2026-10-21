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
}
export const circleOrgKey = circleCreditKey
export const CIRCLE_EXHAUSTED_CREDITS = 20_000

function reason(role: CircleSchedulingRole): string {
  if (role === 'exhausted') return 'Estimated credits left reached the 20,000 reserve for this UTC month.'
  if (role === 'standby') return 'Standby capacity waits for a primary organization to reach its credit reserve.'
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
    && (status.reading.credits != null || status.policy.activated)
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
    const standby = standbys.find(status => !selected.has(status.key)
      && status.reading.credits != null && canReplace(status))
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

  private async evaluate(mirrorName?: string): Promise<Map<string, CircleSchedulingReading>> {
    const orgs = await this.organizations()
    const readings = await Promise.all(orgs.map(org => this.credits.reading(org.owner, org.circleAccountId)))
    const month = circleMonthStart(this.now())
    return this.cache.transaction(state => {
      const statuses = orgs.map((org, index) => {
        const key = circleOrgKey(org.owner, org.circleAccountId)
        const saved = state[key] ??= { attempts: [] }
        if (saved.policy?.month !== month) saved.policy = { month, exhausted: false, activated: false }
        const observed = readings[index]!
        const previousMonth = observed.credits && circleMonthStart(Date.parse(observed.credits.asOf)) !== month
        const reading: CircleCreditsReading = previousMonth
          ? { credits: null, creditsUnavailable: 'Usage from the previous UTC month has expired.' } : observed
        if (reading.credits) saved.policy.exhausted = reading.credits.remaining <= CIRCLE_EXHAUSTED_CREDITS
        return { org, key, reading, policy: saved.policy }
      })
      const selected = selectReplacements(statuses)
      return new Map(statuses.map(status => {
        let role: CircleSchedulingRole = 'standby'
        if (status.policy.exhausted) role = 'exhausted'
        else if ((mirrorName ? status.org.mirrorNames.has(mirrorName) : status.org.mirrorNames.size > 0)
          && (status.org.role === 'primary' || selected.has(status.key))) role = 'active'
        return [status.key, { ...status.reading, schedulingRole: role, schedulingReason: reason(role) }]
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
