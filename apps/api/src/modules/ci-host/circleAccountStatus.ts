import type pg from 'pg'
import type { CircleAccount, CircleOrganizationRead } from '@foreman-code/contracts/management'
import type { CircleAccountStatusReader } from './circleAccounts.js'
import type { CloudCi } from './cloud.js'
import { cloudCiId } from './cloudProviders.js'
import type { CircleStandby } from './circleStandby.js'
import { registeredCircleClouds } from './circleOrganizations.js'

interface OrganizationStatus { cloud: CloudCi; ready: boolean }

function readinessReason(org: CircleOrganizationRead, status: OrganizationStatus | undefined): string[] {
  if (org.ready) return []
  if (!status) return [`${org.account}: Organization discovery has not found a workspace CI mirror project.`]
  if (status.ready) return [`${org.account}: No workspace CI mirror project is available.`]
  const observation = status.cloud.readinessObservation
  const reason = observation?.status === 'unavailable' ? observation.lastError : status.cloud.provider.loginHint
  return [`${org.account}: ${reason}`]
}

/** Account readback uses the fleet owned by dispatch. */
export class CircleAccountFleetStatus implements CircleAccountStatusReader {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly directory: CircleAccountStatusReader, private readonly clouds: readonly CloudCi[],
    private readonly standby: CircleStandby) {}

  async read(account: CircleAccount) {
    const setup = await this.directory.read(account)
    const fleet = registeredCircleClouds(this.clouds)
      .filter(cloud => (cloud.provider.circleAccountId ?? 'default') === account.id)
    const statuses = new Map(await Promise.all(fleet.map(async cloud => [
      cloud.provider.account!.owner.toLowerCase(), { cloud, ready: await cloud.ready() },
    ] as const)))
    const organizations = account.id === 'default' && account.organizations.length === 0
      ? fleet.map(cloud => cloud.provider.account!.owner) : account.organizations
    const counts = await this.runningCounts()
    const orgs = await Promise.all(organizations.map(async owner => {
      const status = statuses.get(owner.toLowerCase())
      return { account: owner, circleAccountId: account.id,
        ...await this.standby.reading(owner, account.id),
        ready: Boolean(status?.ready && status.cloud.provider.account!.mirrorNames.size),
        running: status ? counts.find(row => row.segment === cloudCiId(status.cloud.provider))?.running ?? 0 : 0 }
    }))
    const ready = setup.tokenConfigured && orgs.length > 0 && orgs.every(org => org.ready)
    let reasons = setup.reasons
    if (setup.tokenConfigured) {
      reasons = orgs.length ? orgs.flatMap(org => readinessReason(org, statuses.get(org.account.toLowerCase())))
        : ['No CircleCI organizations have been discovered.']
    }
    return { ...setup, ready, reasons, orgs }
  }

  private async runningCounts() {
    const counts = (await this.pool.query<{ segment: string; running: number }>(`select
      split_part(host_key,':',3) as segment,count(*)::int as running from ci_runs
      where state in ('starting','running') and host_key like $1 group by 1`, [`${this.mainId}:cloud:%`])).rows
    return counts
  }
}
