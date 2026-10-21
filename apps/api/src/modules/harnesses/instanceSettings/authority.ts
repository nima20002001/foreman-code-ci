import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'

export interface HostHarnessOverrideAuthority {
  authorize(principal: ManagementPrincipal, action: 'harnesses:read' | 'harnesses:update', hostRef: CanonicalMachineReference, applicationInstallationId: string, client?: pg.PoolClient): Promise<void>
}
