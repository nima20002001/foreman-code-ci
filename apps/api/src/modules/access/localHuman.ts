import { ManagementActionSchema, ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import type { PostgresAccessService } from './postgres.js'

export const localHumanPrincipal = ManagementPrincipalSchema.parse({
  id: 'principal-local-human',
  name: 'Local human',
  audience: 'operator',
  grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  expiresAt: '9999-12-31T23:59:59.000Z',
  revokedAt: null,
})

export interface LocalHumanAccess {
  current(): Promise<ManagementPrincipal>
}

export class PostgresLocalHumanAccess implements LocalHumanAccess {
  constructor(private readonly pool: pg.Pool, private readonly access: PostgresAccessService) {}

  async current(): Promise<ManagementPrincipal> {
    const result = await this.pool.query<{ principal_id: string }>(
      'select principal_id from local_human_principal where singleton = true',
    )
    const id = result.rows[0]?.principal_id
    if (!id) throw new Error('The implicit local human principal has not been migrated.')
    return this.access.currentOperator(id)
  }
}
