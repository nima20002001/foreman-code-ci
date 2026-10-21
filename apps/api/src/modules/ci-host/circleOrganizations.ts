import type { CloudCi } from './cloud.js'
import type { CircleOrganization } from './circleStandby.js'

/** Registered organization inputs shared by production selection and its readiness checks. */
export async function circleOrganizations(clouds: readonly CloudCi[]): Promise<CircleOrganization[]> {
  return registeredCircleClouds(clouds).map(cloud => {
    const account = cloud.provider.account!
    const circleAccountId = cloud.provider.circleAccountId ?? 'default'
    return { owner: account.owner, circleAccountId,
      role: account.role ?? (circleAccountId === 'default' ? 'primary' : 'standby'),
      mirrorNames: account.mirrorNames, ready: cloud.readinessSnapshot() }
  })
}

export function registeredCircleClouds(clouds: readonly CloudCi[]): CloudCi[] {
  return clouds.filter(cloud => cloud.provider.id === 'circleci'
    && cloud.provider.account && cloud.provider.account.registered !== false)
}
