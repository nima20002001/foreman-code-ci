import type { ManagementGrant } from '@foreman-code/contracts/management'

/** A delegated credential may only lose authority when its parent is changed. */
export function intersectGrants(issued: ManagementGrant[], current: ManagementGrant[]): ManagementGrant[] {
  const result: ManagementGrant[] = []
  for (const left of issued) for (const right of current) {
    const actions = left.actions.filter((action) => right.actions.includes(action))
    if (!actions.length) continue
    const scope: ManagementGrant['scope'] = {}
    let empty = false
    for (const key of ['workspaceIds', 'workflowIds', 'runIds', 'mainIds', 'deviceIds',
      'applicationInstallationIds', 'providerAccountIds'] as const) {
      const a = left.scope[key]; const b = right.scope[key]
      const values = a && b ? a.filter((id) => b.includes(id)) : a ?? b
      if (values && !values.length) empty = true
      if (values) scope[key] = [...values]
    }
    if (!empty) result.push({ actions, scope })
  }
  return result
}
