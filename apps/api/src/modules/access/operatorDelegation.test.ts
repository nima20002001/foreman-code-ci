import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ManagementGrant } from '@foreman-code/contracts/management'
import { intersectGrants } from './operatorDelegation.js'

it.each(['mainIds', 'deviceIds', 'applicationInstallationIds', 'providerAccountIds'] as const)(
  'retains the parent account %s restriction in a delegated credential', key => {
    const allowed = randomUUID()
    const other = randomUUID()
    const issued: ManagementGrant[] = [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }]
    const parent: ManagementGrant[] = [{ actions: ['provider_accounts:read'], scope: { [key]: [allowed] } }]
    expect(intersectGrants(issued, parent)).toEqual(parent)
    const excluded: ManagementGrant[] = [{ actions: ['provider_accounts:read'], scope: { [key]: [other] } }]
    expect(intersectGrants(excluded, parent)).toEqual([])
  })
